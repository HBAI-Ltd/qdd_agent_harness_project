// Runtime-test the extracted production main routing/pump with real protocol,
// owner and HID policy modules; BLE and hardware are deterministic boundaries.
#include "qdd_ble.h"
#include "qdd_text.h"
#include "qdd_control.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#define EVENT_STOP 1u
#define EVENT_MENU 8u
static qdd_hid_state_t s_state;
static qdd_control_t s_control;
static qdd_text_t s_text;
static atomic_bool s_configuring, s_physical_stop;
static atomic_uint s_events;
static uint64_t clock_ms;
static bool transport_live;
static bool driver_reserved;
static char response[256];
static qdd_ble_text_events_t pending_events;
static unsigned indications;
static uint8_t last_frame[64];
static size_t last_size;
static uint32_t next_token;
static qdd_ble_text_send_t send_result;
static uint64_t now_ms(void) { return clock_ms; }
static bool controller_live(void) { return transport_live && s_control.owner != QDD_SOURCE_NONE; }
static bool qdd_driver_usb_reserved(void) { return driver_reserved; }
static bool write_reply(qdd_source_t source, const char *reply) {
  (void)source; assert(strlen(reply) < sizeof(response)); strcpy(response, reply); return true;
}
qdd_ble_text_events_t qdd_ble_text_events(void) {
  const qdd_ble_text_events_t result = pending_events; memset(&pending_events, 0, sizeof(pending_events)); return result;
}
uint16_t qdd_ble_text_mtu(void) { return 23; }
void qdd_ble_text_cancel_pending(void) {}
qdd_ble_text_send_t qdd_ble_text_indicate(const uint8_t *bytes, size_t length, uint64_t deadline_ms, bool (*allowed)(void), uint32_t *token) {
  assert(deadline_ms >= clock_ms && (!allowed || allowed()));
  if (send_result != QDD_BLE_TEXT_QUEUED) return send_result;
  indications++; memcpy(last_frame, bytes, length); last_size = length; *token = ++next_token;
  return QDD_BLE_TEXT_QUEUED;
}
#include "qdd_text_main_extract.h"
static void reset(void) {
  memset(&s_text, 0, sizeof(s_text)); memset(&pending_events, 0, sizeof(pending_events));
  s_state = (qdd_hid_state_t){.connected=true,.encrypted=true,.authenticated=true,.bonded=true,
      .ready=true,.armed=true,.heartbeat_seen=true,.last_ping_ms=100};
  s_control = (qdd_control_t){.owner=QDD_SOURCE_TCP,.last_ping_ms=100};
  clock_ms=100; transport_live=true; driver_reserved=false; indications=next_token=0; response[0]=0;
  atomic_store(&s_events,0); atomic_store(&s_configuring,false); atomic_store(&s_physical_stop,false);
  send_result=QDD_BLE_TEXT_QUEUED; qdd_text_editor(&s_text,true,7);
}
static void request(const char *line, qdd_source_t source, const char *expected) {
  on_text_line(line,source); assert(strstr(response,expected));
}
static void queue(void) {
  request("QDDTXT/1 1 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"\"status\":\"receiving\"");
  request("QDDTXT/1 2 DATA 0000000000000001 0 e4b8ade69687",QDD_SOURCE_TCP,"\"received\":6");
  request("QDDTXT/1 3 COMMIT 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"queued\"");
  assert(!indications); // Serial queued ACK precedes GATT pump; never accepted early.
}
static void confirm(void) {
  pending_events.indication_done=true; pending_events.indication_success=true;
  pending_events.indication_token=s_text.flight_token; sync_text();
}
static void test_router_gate(void) {
  reset(); s_state.armed=false;
  request("QDDTXT/1 1 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"ERR NOT_ARMED"); assert(!s_state.armed);
  request("QDDTXT/1 2 STATUS 0000000000000000",QDD_SOURCE_USB,"\"editorEpoch\":7"); assert(s_control.owner==QDD_SOURCE_TCP);
  s_state.armed=true;
  request("QDDTXT/1 3 BEGIN 0000000000000001 7 6",QDD_SOURCE_USB,"ERR CONTROL_BUSY");
  atomic_store(&s_configuring,true);
  request("QDDTXT/1 4 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"ERR CONFIGURING");
  request("QDDTXT/1 5 STATUS 0",QDD_SOURCE_USB," OK "); atomic_store(&s_configuring,false);
  atomic_store(&s_physical_stop,true);
  request("QDDTXT/1 6 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"ERR LOCKED"); atomic_store(&s_physical_stop,false);
  s_state.encrypted=false;
  request("QDDTXT/1 7 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"ERR NOT_AUTHENTICATED");
  s_state.encrypted=true; s_state.bonded=false;
  request("QDDTXT/1 7 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"ERR NOT_AUTHENTICATED");
  s_state.bonded=true; clock_ms=1601;
  request("QDDTXT/1 8 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP,"ERR HEARTBEAT_EXPIRED");
  assert(!s_text.id && !indications);
  reset(); s_state.armed=false; s_control.owner=QDD_SOURCE_NONE; driver_reserved=true;
  request("QDDTXT/1 9 BEGIN 0000000000000001 7 6",QDD_SOURCE_USB,"ERR CONTROL_BUSY");
  request("QDDTXT/1 10 STATUS 0",QDD_SOURCE_USB," OK ");
  assert(s_control.owner==QDD_SOURCE_NONE && !s_state.armed && !s_text.id && !indications);
}
static void test_just_works_text_gate(void) {
  reset(); s_state.authenticated=false;
  assert(text_fast_allowed());
  queue(); sync_text(); assert(indications==1);
  s_state.bonded=false;
  assert(strcmp(qdd_hid_text_permission(&s_state,clock_ms),"NOT_AUTHENTICATED")==0);
  sync_text(); assert(s_text.status==QDD_TEXT_UNCERTAIN);
}
static void test_pump_and_terminal_epoch(void) {
  reset(); queue(); sync_text(); assert(indications==1 && last_size==16 && last_frame[1]==1);
  sync_text(); assert(indications==1); // At most one indication in flight.
  pending_events.indication_done=true; pending_events.indication_token=999; pending_events.indication_success=true;
  sync_text(); assert(indications==1 && s_text.in_flight);
  confirm(); assert(indications==2 && last_frame[1]==2 && last_size==18);
  confirm(); assert(indications==3 && last_frame[1]==3 && last_size==14);
  pending_events.ack_received=true; pending_events.ack_id=1; pending_events.ack_epoch=7;
  pending_events.ack_status=0; pending_events.editor_changed=true; pending_events.ready=false; pending_events.editor_epoch=8;
  sync_text(); assert(s_text.status==QDD_TEXT_ACCEPTED && !s_text.ready);
  for(unsigned i=0;i<512;i++) assert(!s_text.text[i]);
  request("QDDTXT/1 10 STATUS 0000000000000001",QDD_SOURCE_USB,"\"editorEpoch\":7");
  request("QDDTXT/1 11 STATUS 0",QDD_SOURCE_USB,"\"editorEpoch\":8");
  request("QDDTXT/1 12 COMMIT 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"accepted\"");
  confirm(); sync_text(); assert(indications==3);
}
static void test_pause_loss_busy_and_failure(void) {
  reset(); queue(); send_result=QDD_BLE_TEXT_BUSY; sync_text(); assert(!indications && s_text.status==QDD_TEXT_QUEUED);
  send_result=QDD_BLE_TEXT_QUEUED; sync_text(); assert(indications==1);
  s_state.armed=false; sync_text(); assert(s_text.status==QDD_TEXT_UNCERTAIN && !s_text.text[0]);
  confirm(); assert(indications==2 && last_frame[1]==4); // Only neutral cancel may follow PAUSE.
  confirm(); assert(!s_text.cancel_id && indications==2);
  reset(); queue(); transport_live=false; sync_text(); assert(s_text.status==QDD_TEXT_UNCERTAIN);
  reset(); queue(); send_result=QDD_BLE_TEXT_FAILED; sync_text();
  assert(s_text.status==QDD_TEXT_UNCERTAIN && !s_text.ready && !indications);
  reset(); request("QDDTXT/1 1 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP," OK ");
  pending_events.editor_changed=true; pending_events.ready=false; pending_events.editor_epoch=8;
  sync_text(); assert(s_text.status==QDD_TEXT_REJECTED && !s_text.text[0]);
}
int main(void) {
  test_router_gate(); test_pump_and_terminal_epoch(); test_pause_loss_busy_and_failure(); test_just_works_text_gate();
  puts("QDD text production main routing, safety gates, single-flight pump and terminal epoch: PASS"); return 0;
}
