// Runtime-test the actual public-event-queue sender against a deterministic
// one-slot NimBLE boundary. No private NimBLE structures are part of production.
#include "qdd_ble.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#define BLE_HS_EDONE 14
#define BLE_HS_ENOMEM 6
#define BLE_HS_ETIMEOUT 13
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
struct ble_npl_event { int unused; };
struct os_mbuf { uint8_t bytes[64]; size_t length; };
static int s_lock;
static qdd_ble_status_t s_status;
static atomic_uint_fast16_t s_connection;
static uint16_t s_text_handle;
static bool s_text_subscribed,s_text_indication_busy,s_text_requested,s_att_indication_busy,s_text_cancelled,s_text_neutral,s_text_event_enqueued;
static uint8_t s_text_staging[64];
static size_t s_text_length;
static uint64_t s_text_deadline;
static bool (*s_text_allowed)(void);
static struct ble_npl_event s_text_send_event;
static uint32_t s_text_next_token,s_text_flight_token;
static qdd_ble_text_events_t s_text_events;
struct mock_event { struct { uint16_t conn_handle,attr_handle; bool indication; int status; } notify_tx; };
static bool queued,att_slot,fast_allowed;
static unsigned mbufs,allocated,freed,sends,enqueues;
static uint64_t clock_ms;
static struct os_mbuf one_frame;
static void text_send_event(struct ble_npl_event *event);
static void *nimble_port_get_dflt_eventq(void) { return NULL; }
static void ble_npl_eventq_put(void *queue,struct ble_npl_event *event) {
  (void)queue; assert(event==&s_text_send_event); assert(!queued); enqueues++; queued=true;
}
static uint64_t now_ms(void) { return clock_ms; }
uint16_t qdd_ble_text_mtu(void) { return 23; }
static bool allowed(void) { return fast_allowed; }
static struct os_mbuf *ble_hs_mbuf_from_flat(const void *bytes,size_t length) {
  assert(!mbufs); mbufs++; allocated++; memcpy(one_frame.bytes,bytes,length); one_frame.length=length; return &one_frame;
}
static void os_mbuf_free_chain(struct os_mbuf *frame) { if(frame){assert(mbufs==1); mbufs--; freed++;} }
#include "qdd_text_ble_notify_extract.h"
static void notify(uint16_t handle,int status) {
  struct mock_event value={.notify_tx={.conn_handle=1,.attr_handle=handle,.indication=true,.status=status}};
  assert(!production_notify(&value));
}
static int ble_gatts_indicate_custom(uint16_t connection,uint16_t handle,struct os_mbuf *frame) {
  assert(connection==1 && handle==s_text_handle && !att_slot && mbufs==1);
  att_slot=true; sends++; notify(handle,0); os_mbuf_free_chain(frame); return 0;
}
#include "qdd_text_ble_extract.h"
static void pump(void) { if(queued){queued=false; text_send_event(&s_text_send_event);} }
static void confirm(uint16_t handle) { att_slot=false; notify(handle,BLE_HS_EDONE); }
static void reset(void) {
  assert(!mbufs); queued=att_slot=false; fast_allowed=true; clock_ms=100; sends=allocated=freed=enqueues=0;
  s_status=(qdd_ble_status_t){.connected=true,.encrypted=true,.authenticated=true,.bonded=true,.key_size=16};
  s_connection=1; s_text_handle=40; s_text_subscribed=true;
  s_text_indication_busy=s_text_requested=s_att_indication_busy=s_text_cancelled=s_text_neutral=s_text_event_enqueued=false;
  s_text_length=0; memset(s_text_staging,0,sizeof(s_text_staging)); memset(&s_text_events,0,sizeof(s_text_events));
}
static uint32_t queue(void) {
  const uint8_t frame[]={1,3,1,0,0,0,0,0,0,0,7,0,0,0}; uint32_t token=0;
  assert(qdd_ble_text_indicate(frame,sizeof(frame),1600,allowed,&token)==QDD_BLE_TEXT_QUEUED && token);
  return token;
}
static void test_service_changed_slot_and_one_mbuf(void) {
  reset(); att_slot=true; notify(3,0); const uint32_t token=queue();
  pump(); assert(!allocated && !sends && s_text_requested); // Standard indication already owns slot.
  uint32_t ignored; const uint8_t b[14]={0};
  assert(qdd_ble_text_indicate(b,sizeof(b),1600,allowed,&ignored)==QDD_BLE_TEXT_BUSY);
  confirm(3); assert(queued); pump(); assert(sends==1 && allocated==1 && freed==1 && !mbufs);
  assert(!s_text_events.indication_done && s_att_indication_busy); // Sent is not confirmed.
  pump(); assert(sends==1);
  confirm(40); assert(s_text_events.indication_done && s_text_events.indication_success && s_text_events.indication_token==token);
  assert(!s_text_indication_busy && !s_att_indication_busy && !s_text_length);
  for(unsigned i=0;i<64;i++) assert(!s_text_staging[i]);
}
static void test_cancel_and_deadline_before_host_sender(void) {
  reset(); uint32_t token=queue(); qdd_ble_text_cancel_pending(); pump();
  assert(!allocated && !sends && s_text_events.indication_done && !s_text_events.indication_success && s_text_events.indication_token==token);
  reset(); queue(); fast_allowed=false; pump(); assert(!allocated && !sends && s_text_events.indication_done);
  reset(); queue(); clock_ms=1601; pump(); assert(!allocated && !sends && s_text_events.indication_done);
  reset(); queue(); s_status.encrypted=false; pump(); assert(!allocated && !sends && s_text_events.indication_done);
}
static void test_service_changed_timeout_is_not_slot_confirmation(void) {
  reset(); att_slot=true; notify(3,0); queue(); pump(); assert(s_text_requested && !allocated && !queued);
  // The SDK timeout callback precedes asynchronous DISCONNECT and does not
  // clear its outstanding handle. No text/CANCEL may enter the slot here.
  notify(3,BLE_HS_ETIMEOUT);
  assert(s_att_indication_busy && !queued && !allocated && !sends);
  pump(); assert(!sends);
}
static void test_two_producers_deduplicate_pending_host_event(void) {
  reset(); att_slot=true; notify(3,0); queue(); assert(enqueues==1 && queued);
  // A standard confirmation racing the main producer must not enqueue twice.
  confirm(3); assert(enqueues==1 && queued); pump(); assert(sends==1);
  confirm(40); assert(!s_text_indication_busy && enqueues==1);
}
static void test_neutral_cancel_survives_closed_input_gate(void) {
  reset(); att_slot=true; notify(3,0);
  const uint8_t frame[10]={1,4,1}; uint32_t token=0;
  assert(qdd_ble_text_indicate(frame,sizeof(frame),UINT64_MAX,NULL,&token)==QDD_BLE_TEXT_QUEUED);
  qdd_ble_text_cancel_pending(); pump(); assert(s_text_requested && !allocated && !s_text_events.indication_done);
  confirm(3); pump(); assert(sends==1 && allocated==1 && freed==1);
  confirm(40); assert(s_text_events.indication_success && s_text_events.indication_token==token);
}
static void test_confirm_then_cancel_never_replays(void) {
  reset(); queue(); pump(); assert(sends==1); qdd_ble_text_cancel_pending();
  assert(s_text_indication_busy); confirm(40); assert(!s_text_indication_busy); pump(); assert(sends==1 && !mbufs);
}
static void test_just_works_and_security_loss(void) {
  reset(); s_status.authenticated=false; queue(); pump();
  assert(sends==1 && !s_status.authenticated); confirm(40);
  const uint8_t bytes[14]={1,3,1}; uint32_t token;
  reset(); s_status.authenticated=false; s_status.bonded=false;
  assert(qdd_ble_text_indicate(bytes,sizeof(bytes),1600,allowed,&token)==QDD_BLE_TEXT_FAILED);
  assert(!queued && !allocated);
  reset(); s_status.authenticated=false; queue(); s_status.bonded=false; pump();
  assert(!sends && !allocated && s_text_events.indication_done && !s_text_events.indication_success);
  reset(); s_status.authenticated=false; s_status.encrypted=false;
  assert(qdd_ble_text_indicate(bytes,sizeof(bytes),1600,allowed,&token)==QDD_BLE_TEXT_FAILED);
  assert(!queued && !allocated);
  for (unsigned size=7;size<=15;size+=8) {
    reset(); s_status.authenticated=false; s_status.key_size=size;
    assert(qdd_ble_text_indicate(bytes,sizeof(bytes),1600,allowed,&token)==QDD_BLE_TEXT_FAILED);
    assert(!queued && !allocated);
    reset(); s_status.authenticated=false; queue(); s_status.key_size=size; pump();
    assert(!sends && !allocated && s_text_events.indication_done && !s_text_events.indication_success);
  }
}
int main(void) {
  test_service_changed_slot_and_one_mbuf(); test_cancel_and_deadline_before_host_sender(); test_confirm_then_cancel_never_replays(); test_neutral_cancel_survives_closed_input_gate(); test_two_producers_deduplicate_pending_host_event(); test_service_changed_timeout_is_not_slot_confirmation();
  test_just_works_and_security_loss();
  puts("QDD text actual BLE public queue, shared Service Changed slot, one mbuf, cancellation and deadline: PASS"); return 0;
}
