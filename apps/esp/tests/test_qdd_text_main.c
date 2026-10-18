// Runtime-test the extracted production main routing/pump with real protocol,
// owner and HID policy modules; BLE and hardware are deterministic boundaries.
#include "qdd_ble.h"
#include "qdd_text.h"
#include "qdd_control.h"
#include "qdd_driver_protocol.h"
#include "qdd_setup_model.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#define EVENT_STOP 1u
#define EVENT_MENU 8u
#define EVENT_UNLOCK 4u
#define EVENT_CONFIG_UP 32u
#define EVENT_CONFIG_DOWN 64u
#define EVENT_CONFIG_OK 128u
#define EVENT_CONFIG_LONG 256u
#define EVENT_SKIP_APP 512u
#define EVENT_SKIP_BLUETOOTH 1024u
#define EVENT_DESKTOP_READY 2048u
#define EVENT_WIFI_SETUP 4096u
#define EVENT_GUIDE_PAIR 8192u
#define SKIP_APP 1u
#define SKIP_BLUETOOTH 2u
#define SKIP_DESKTOP 4u
static qdd_hid_state_t s_state;
static qdd_control_t s_control;
static qdd_text_t s_text;
static qdd_stream_t s_usb_stream,s_tcp_stream;
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
static bool receiver_current, hid_send_ok;
static unsigned paste_presses, keyboard_releases;
static uint32_t s_link_epoch;
static bool s_guide_pair_requested;
static atomic_uint s_onboarding_skips,s_home_selection;
static qdd_setup_model_t s_setup;
static uint64_t now_ms(void) { return clock_ms; }
static bool controller_live(void) { return transport_live && s_control.owner != QDD_SOURCE_NONE; }
static bool qdd_driver_usb_reserved(void) { return driver_reserved; }
static unsigned qdd_ui_guide_step(void) { return 0; }
void qdd_ble_pairing_context(bool active) { (void)active; }
void qdd_ble_poll(void) {}
qdd_ble_status_t qdd_ble_status(void) {
  return (qdd_ble_status_t){.connected=s_state.connected,.encrypted=s_state.encrypted,.authenticated=s_state.authenticated,
    .bonded=s_state.bonded,.key_size=16,.ready=s_state.ready,.consumer_ready=s_state.consumer_ready,.link_epoch=1};
}
const char *qdd_ble_name(void) { return "Test board"; }
void qdd_ble_open_pairing(void) {}
static bool qdd_driver_usb_take_reply_failure(void) { return false; }
static bool usb_live(void) { return transport_live; }
static bool qdd_wifi_tcp_live(void) { return transport_live; }
static void qdd_wifi_close_client(void) { transport_live=false; }
static void qdd_wifi_allow_reconnect(bool allowed) { (void)allowed; }
static void qdd_driver_usb_tick(bool live,bool control_busy) { (void)live;(void)control_busy; }
static void drop_controller(qdd_source_t source) { (void)source; assert(false); }
static void ui_feedback(const char *message) { (void)message; }
static void setup_action(qdd_setup_action_t action) { (void)action; }
static void setup_key(qdd_setup_key_t key) { (void)key; }
static void qdd_driver_usb_submit(const qdd_driver_command_t *command) { (void)command; assert(false); }
static void on_net_line(const char *line,qdd_source_t source) { (void)line;(void)source;assert(false); }
static bool write_reply(qdd_source_t source, const char *reply) {
  (void)source; assert(strlen(reply) < sizeof(response)); strcpy(response, reply); return true;
}
qdd_ble_text_events_t qdd_ble_text_events(void) {
  const qdd_ble_text_events_t result = pending_events; memset(&pending_events, 0, sizeof(pending_events)); return result;
}
uint16_t qdd_ble_text_mtu(void) { return 23; }
bool qdd_ble_text_current(uint8_t version,uint32_t epoch) { return receiver_current && version==2 && epoch==7; }
bool qdd_ble_report(uint8_t id,const uint8_t *data,size_t length,void *context) {
  (void)context;
  if(id==QDD_REPORT_KEYBOARD) {
    assert(length==8);
    if(data[2]) { assert(data[0]==1 && data[2]==25); paste_presses++; }
    else { assert(!data[0]); keyboard_releases++; }
  }
  return hid_send_ok;
}
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
  send_result=QDD_BLE_TEXT_QUEUED; qdd_text_editor(&s_text,true,7, 1);
  receiver_current=hid_send_ok=true; paste_presses=keyboard_releases=0;
  s_link_epoch=1; s_guide_pair_requested=false; memset(&s_setup,0,sizeof(s_setup));
  atomic_store(&s_onboarding_skips,0); atomic_store(&s_home_selection,0);
  memset(&s_usb_stream,0,sizeof(s_usb_stream)); memset(&s_tcp_stream,0,sizeof(s_tcp_stream));
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
  pending_events.indication_token=s_text.flight_token; sync_text(true);
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
  queue(); sync_text(true); assert(indications==1);
  s_state.bonded=false;
  assert(strcmp(qdd_hid_text_permission(&s_state,clock_ms),"NOT_AUTHENTICATED")==0);
  sync_text(true); assert(s_text.status==QDD_TEXT_UNCERTAIN);
}
static void test_pump_and_terminal_epoch(void) {
  reset(); queue(); sync_text(true); assert(indications==1 && last_size==16 && last_frame[1]==1);
  sync_text(true); assert(indications==1); // At most one indication in flight.
  pending_events.indication_done=true; pending_events.indication_token=999; pending_events.indication_success=true;
  sync_text(true); assert(indications==1 && s_text.in_flight);
  confirm(); assert(indications==2 && last_frame[1]==2 && last_size==18);
  confirm(); assert(indications==3 && last_frame[1]==3 && last_size==14);
  pending_events.ack_received=true; pending_events.ack_id=1; pending_events.ack_epoch=7;
  pending_events.ack_status=0; pending_events.ack_version=1; pending_events.editor_changed=true; pending_events.ready=false; pending_events.editor_epoch=8; pending_events.receiver_version=1;
  sync_text(true); assert(s_text.status==QDD_TEXT_ACCEPTED && !s_text.ready);
  for(unsigned i=0;i<512;i++) assert(!s_text.text[i]);
  request("QDDTXT/1 10 STATUS 0000000000000001",QDD_SOURCE_USB,"\"editorEpoch\":7");
  request("QDDTXT/1 11 STATUS 0",QDD_SOURCE_USB,"\"editorEpoch\":8");
  request("QDDTXT/1 12 COMMIT 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"accepted\"");
  confirm(); sync_text(true); assert(indications==3);
}
static void test_pause_loss_busy_and_failure(void) {
  reset(); queue(); send_result=QDD_BLE_TEXT_BUSY; sync_text(true); assert(!indications && s_text.status==QDD_TEXT_QUEUED);
  send_result=QDD_BLE_TEXT_QUEUED; sync_text(true); assert(indications==1);
  s_state.armed=false; sync_text(true); assert(s_text.status==QDD_TEXT_UNCERTAIN && !s_text.text[0]);
  confirm(); assert(indications==2 && last_frame[1]==4); // Only neutral cancel may follow PAUSE.
  confirm(); assert(!s_text.cancel_id && indications==2);
  reset(); queue(); transport_live=false; sync_text(true); assert(s_text.status==QDD_TEXT_UNCERTAIN);
  reset(); queue(); send_result=QDD_BLE_TEXT_FAILED; sync_text(true);
  assert(s_text.status==QDD_TEXT_UNCERTAIN && !s_text.ready && !indications);
  reset(); request("QDDTXT/1 1 BEGIN 0000000000000001 7 6",QDD_SOURCE_TCP," OK ");
  pending_events.editor_changed=true; pending_events.ready=false; pending_events.editor_epoch=8; pending_events.receiver_version=1;
  sync_text(true); assert(s_text.status==QDD_TEXT_REJECTED && !s_text.text[0]);
}
static void queue_clipboard(unsigned ack) {
  qdd_text_editor(&s_text,true,7,2);
  request("QDDTXT/1 1 CLIP_BEGIN 0000000000000001 7 6",s_control.owner,"\"mode\":\"clipboard\"");
  request("QDDTXT/1 2 DATA 0000000000000001 0 e4b8ade69687",s_control.owner,"\"received\":6");
  request("QDDTXT/1 3 COMMIT 0000000000000001",s_control.owner,"\"status\":\"queued\"");
  sync_text(true); assert(last_frame[0]==2); confirm(); confirm(); confirm();
  pending_events.ack_received=true; pending_events.ack_id=1; pending_events.ack_epoch=7;
  pending_events.ack_status=ack; pending_events.ack_version=2; sync_text(true);
  assert(!paste_presses && !keyboard_releases);
}
static void start_paste(void) {
  request("QDDTXT/1 10 PASTE 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"paste_pending\"");
  assert(!paste_presses); sync_text(true); assert(paste_presses==1);
}
static void test_clipboard_pulse_and_replay(void) {
  reset(); queue_clipboard(0); start_paste();
  request("QDDTXT/1 11 PASTE 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"paste_pending\"");
  clock_ms=149; sync_text(true); assert(paste_presses==1 && !keyboard_releases);
  clock_ms=150; sync_text(true); assert(paste_presses==1 && keyboard_releases==1 && s_text.status==QDD_TEXT_PASTE_SENT);
  for(unsigned i=0;i<3;i++) {
    request("QDDTXT/1 12 PASTE 0000000000000001",QDD_SOURCE_TCP,"\"pasteSent\":true"); sync_text(true);
  }
  assert(paste_presses==1 && keyboard_releases==1);
  reset(); queue_clipboard(3); receiver_current=false;
  request("QDDTXT/1 10 PASTE 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"paste_pending\"");
  sync_text(true); assert(!paste_presses && s_text.status==QDD_TEXT_PASTE_UNCERTAIN);
}
static void test_clipboard_cancel_and_new_round(void) {
  for(unsigned reason=0;reason<7;reason++) {
    reset(); queue_clipboard(3); start_paste(); clock_ms=120;
    if(reason==0) request("QDDTXT/1 11 CANCEL 0000000000000001",QDD_SOURCE_TCP,"\"status\":\"paste_uncertain\"");
    if(reason==1) atomic_store(&s_physical_stop,true);
    if(reason==2) transport_live=false;
    if(reason==3) { pending_events.editor_changed=true; pending_events.ready=false; pending_events.receiver_version=2; pending_events.editor_epoch=7; }
    if(reason==4) s_state.connected=false;
    if(reason==5) {
      text_before_hid(QDD_ARM);
      const qdd_command_t arm={.op=QDD_ARM}; assert(!qdd_hid_execute(&s_state,&arm,clock_ms,report,NULL));
    }
    if(reason==6) atomic_store(&s_configuring,true);
    sync_text(true); assert(s_text.status==QDD_TEXT_PASTE_UNCERTAIN && !s_text.paste_stage && !s_text.paste_release_required);
    const unsigned released=keyboard_releases;
    clock_ms=200; sync_text(true); assert(paste_presses==1 && keyboard_releases==released);
  }
  reset(); queue_clipboard(0); start_paste();
  request("QDDTXT/1 11 CANCEL 0000000000000001",QDD_SOURCE_USB,"ERR CONTROL_BUSY");
  assert(!keyboard_releases && s_text.status==QDD_TEXT_PASTE_PENDING);
  clock_ms=150; sync_text(true); assert(s_text.status==QDD_TEXT_PASTE_SENT);
  reset(); queue_clipboard(0); hid_send_ok=false; start_paste();
  assert(s_text.status==QDD_TEXT_PASTE_UNCERTAIN && !s_text.paste_stage);
  hid_send_ok=true; sync_text(true); assert(paste_presses==1);
}
static void test_full_line_route_cancels_before_paste_press(void) {
  const char *stops[]={"QDDTXT/1 11 CANCEL 0000000000000001\n","QDDHID/1 11 ARM\n",
    "QDDHID/1 11 PAUSE\n","QDDHID/1 11 RELEASE\n"};
  for(unsigned index=0;index<4;index++) {
    reset(); queue_clipboard(3);
    char batch[128]; snprintf(batch,sizeof(batch),"QDDTXT/1 10 PASTE 0000000000000001\n%s",stops[index]);
    qdd_stream_feed(&s_tcp_stream,(const uint8_t *)batch,strlen(batch),on_line,(void *)(uintptr_t)QDD_SOURCE_TCP);
    assert(!paste_presses && !s_text.paste_stage && s_text.status==QDD_TEXT_PASTE_UNCERTAIN);
    clock_ms=200; sync_safety(true); assert(!paste_presses);
  }
  for(unsigned index=0;index<4;index++) {
    reset(); queue_clipboard(0);
    on_line("QDDTXT/1 10 PASTE 0000000000000001",NULL,(void *)(uintptr_t)QDD_SOURCE_TCP);
    qdd_stream_feed(&s_usb_stream,(const uint8_t *)stops[index],strlen(stops[index]),on_line,(void *)(uintptr_t)QDD_SOURCE_USB);
    assert(strstr(response,"CONTROL_BUSY") && !paste_presses && s_text.status==QDD_TEXT_PASTE_PENDING && s_control.owner==QDD_SOURCE_TCP);
    // A foreign partial line cannot delay the owner's paste.
    qdd_stream_feed(&s_usb_stream,(const uint8_t *)"QDDTXT/1",8,on_line,(void *)(uintptr_t)QDD_SOURCE_USB);
    sync_safety(true); assert(paste_presses==1);
    clock_ms=150;
    on_line("QDDHID/1 12 STATUS",NULL,(void *)(uintptr_t)QDD_SOURCE_TCP);
    assert(paste_presses==1 && keyboard_releases==1 && s_text.status==QDD_TEXT_PASTE_SENT);
  }
  const char batch[]="QDDTXT/1 10 PASTE 0000000000000001\nQDDTXT/1 11 CANCEL 0000000000000001\n";
  assert(strlen(batch)>64);
  const qdd_source_t sources[]={QDD_SOURCE_USB,QDD_SOURCE_TCP};
  for(unsigned index=0;index<2;index++) {
    reset(); s_control.owner=sources[index]; queue_clipboard(3);
    qdd_stream_t *stream=sources[index]==QDD_SOURCE_USB?&s_usb_stream:&s_tcp_stream;
    qdd_stream_feed(stream,(const uint8_t *)batch,64,on_line,(void *)(uintptr_t)sources[index]);
    sync_safety(true); assert(!paste_presses && s_text.status==QDD_TEXT_PASTE_PENDING && stream->length);
    qdd_stream_feed(stream,(const uint8_t *)batch+64,strlen(batch)-64,on_line,(void *)(uintptr_t)sources[index]);
    sync_safety(true); assert(!paste_presses && s_text.status==QDD_TEXT_PASTE_UNCERTAIN);
  }
  reset(); queue_clipboard(0); start_paste();
  qdd_stream_feed(&s_tcp_stream,(const uint8_t *)"QDDTXT/1",8,on_line,(void *)(uintptr_t)QDD_SOURCE_TCP);
  clock_ms=150; sync_safety(true);
  assert(paste_presses==1 && keyboard_releases==1 && s_text.status==QDD_TEXT_PASTE_SENT);
}
int main(void) {
  test_router_gate(); test_pump_and_terminal_epoch(); test_pause_loss_busy_and_failure(); test_just_works_text_gate();
  test_clipboard_pulse_and_replay(); test_clipboard_cancel_and_new_round();
  test_full_line_route_cancels_before_paste_press();
  puts("QDD text production main routing, safety gates, single-flight pump and terminal epoch: PASS"); return 0;
}
