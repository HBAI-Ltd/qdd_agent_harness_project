// Execute production GAP, security, report and advertising functions. The
// mock only replaces the public NimBLE boundary, never the decision logic.
#include "qdd_ble.h"
#include "qdd_ble_policy.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
#define BLE_HS_CONN_HANDLE_NONE 0xffff
#define BLE_ERR_REM_USER_CONN_TERM 19
#define BLE_HS_EALREADY 2
#define BLE_SM_IOACT_NONE 0
#define BLE_HS_ADV_F_DISC_GEN 2
#define BLE_HS_ADV_F_BREDR_UNSUP 4
#define BLE_GAP_CONN_MODE_UND 2
#define BLE_GAP_DISC_MODE_GEN 2
#define BLE_HS_FOREVER 0x7fffffff
#define REPORT_MODE 1
#define BLE_UUID16_INIT(value) (value)
#define BLE_ATT_ERR_INSUFFICIENT_AUTHEN 5
#define BLE_ATT_ERR_WRITE_NOT_PERMITTED 3
#define BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN 13
#define BLE_ATT_ERR_VALUE_NOT_ALLOWED 19
#define BLE_ATT_ERR_UNLIKELY 14
#define BLE_GATT_ACCESS_OP_READ_CHR 0
#define BLE_GATT_ACCESS_OP_WRITE_CHR 1
#define OS_MBUF_PKTLEN(frame) ((frame)->length)
typedef uint16_t ble_uuid16_t;
struct ble_gap_conn_desc {
  struct { bool encrypted, authenticated, bonded; uint8_t key_size; } sec_state;
  unsigned peer_id_addr;
};
struct mock_event {
  struct { int status; uint16_t conn_handle; } connect, enc_change;
  struct { uint16_t conn_handle; struct { int action; } params; } passkey;
};
struct ble_hs_adv_fields {
  uint8_t flags; uint16_t appearance; bool appearance_is_present;
  ble_uuid16_t *uuids16; uint8_t num_uuids16; bool uuids16_is_complete;
  const uint8_t *name; uint8_t name_len; bool name_is_complete;
};
struct ble_gap_adv_params { int conn_mode, disc_mode; };
struct os_mbuf { uint8_t bytes[32]; size_t length; };
struct ble_gatt_access_ctxt { int op; struct os_mbuf *om; };
static int s_lock;
static char s_name[24];
static uint8_t s_address_type;
static atomic_uint_fast16_t s_connection;
static atomic_bool s_new_peer;
static qdd_ble_status_t s_status;
static qdd_ble_policy_t s_policy;
static qdd_hid_subscriptions_t s_subscriptions;
static bool s_suspended, s_text_subscribed;
static qdd_ble_text_events_t s_text_events;
static uint16_t s_input_handles[2][4];
static struct ble_gap_conn_desc peer;
static unsigned terminated, security_requests, reset_calls, advertising_requests, reports;
static bool peer_known;
static uint64_t clock_ms;
static struct os_mbuf packet;
static struct ble_hs_adv_fields captured_advertisement;
static int gap_event(struct mock_event *event, void *argument) { (void)event; (void)argument; return 0; }
static uint64_t now_ms(void) { return clock_ms; }
static void reset_link(void) { reset_calls++; }
static void request_advertising(void) { advertising_requests++; }
static void text_reset_locked(void) {}
static bool known_peer(const unsigned *address) { (void)address; return peer_known; }
static int ble_gap_conn_find(uint16_t connection, struct ble_gap_conn_desc *desc) {
  assert(connection == 1); *desc = peer; return 0;
}
static int ble_gap_security_initiate(uint16_t connection) { assert(connection==1); security_requests++; return 0; }
static int ble_gap_terminate(uint16_t connection, int reason) {
  assert(connection == 1 && reason == BLE_ERR_REM_USER_CONN_TERM); terminated++; return 0;
}
static int ble_gap_adv_set_fields(const struct ble_hs_adv_fields *fields) {
  captured_advertisement = *fields;
  const unsigned bytes = 3 + (fields->appearance_is_present ? 4 : 0) +
      (fields->num_uuids16 ? 2 + 2 * fields->num_uuids16 : 0) + (fields->name_len ? fields->name_len + 2 : 0);
  assert(bytes == 30 && bytes <= 31); return 0;
}
static int ble_gap_adv_rsp_set_fields(const struct ble_hs_adv_fields *fields) {
  assert(!fields->name && !fields->name_len); return 0;
}
static int ble_gap_adv_start(uint8_t type, const void *address, int duration,
    const struct ble_gap_adv_params *params, int (*callback)(struct mock_event *, void *), void *argument) {
  (void)type; assert(!address && !argument && duration == BLE_HS_FOREVER && callback == gap_event);
  assert(params->conn_mode == BLE_GAP_CONN_MODE_UND && params->disc_mode == BLE_GAP_DISC_MODE_GEN); return 0;
}
void qdd_ble_poll(void) {}
static struct os_mbuf *ble_hs_mbuf_from_flat(const void *data, size_t length) {
  assert(length <= sizeof(packet.bytes)); memcpy(packet.bytes, data, length); packet.length = length; return &packet;
}
static int ble_hs_mbuf_to_flat(const struct os_mbuf *frame, void *output, size_t length, void *unused) {
  (void)unused; assert(length == frame->length); memcpy(output, frame->bytes, length); return 0;
}
static int ble_gatts_notify_custom(uint16_t connection, uint16_t handle, struct os_mbuf *frame) {
  assert(connection == 1 && handle == 10 && frame == &packet); reports++; return 0;
}
#include "qdd_ble_pairing_extract.h"

static void reset(void) {
  s_status = (qdd_ble_status_t){0}; s_policy = (qdd_ble_policy_t){0};
  s_connection = 1; s_new_peer = false; s_suspended = false; clock_ms = 100;
  peer = (struct ble_gap_conn_desc){.sec_state={.encrypted=true,.authenticated=false,.bonded=true,.key_size=16}};
  terminated = security_requests = reset_calls = advertising_requests = reports = 0;
  qdd_hid_subscriptions_reset(&s_subscriptions);
  qdd_hid_subscriptions_set(&s_subscriptions,1,QDD_REPORT_MOUSE,true);
  qdd_hid_subscriptions_set(&s_subscriptions,1,QDD_REPORT_KEYBOARD,true);
  qdd_hid_subscriptions_set(&s_subscriptions,1,QDD_REPORT_CONSUMER,true);
  s_input_handles[1][QDD_REPORT_MOUSE] = 10;
  strcpy(s_name,"QDD-Passport-A1BA"); peer_known = false;
}
static void test_just_works_security_and_reports(void) {
  reset(); qdd_ble_pairing_context(true); s_new_peer = true;
  assert(s_status.pairing_open);
  struct mock_event event = {.enc_change={.conn_handle=1,.status=0}};
  assert(!production_encryption(&event));
  assert(s_status.connected && s_status.encrypted && s_status.bonded && s_status.ready);
  assert(!s_status.authenticated && !s_status.pairing_open && !terminated);
  qdd_ble_pairing_context(false); assert(!terminated);
  const uint8_t movement[4]={0,1,0,0};
  assert(qdd_ble_report(QDD_REPORT_MOUSE,movement,sizeof(movement),NULL) && reports==1);
  struct ble_gatt_access_ctxt read = {.op=BLE_GATT_ACCESS_OP_READ_CHR};
  assert(text_access(1,0,&read,NULL)==0);
  peer.sec_state.encrypted=false; assert(!production_encryption(&event));
  assert(terminated==1 && !s_status.ready);
  assert(!qdd_ble_report(QDD_REPORT_MOUSE,movement,sizeof(movement),NULL) && reports==1);
  assert(text_access(1,0,&read,NULL)==BLE_ATT_ERR_INSUFFICIENT_AUTHEN);
  reset(); peer.sec_state.bonded=false; assert(!production_encryption(&event));
  assert(terminated==1 && !s_status.ready);
  assert(text_access(1,0,&read,NULL)==BLE_ATT_ERR_INSUFFICIENT_AUTHEN);
  reset(); peer.sec_state.authenticated=true; assert(!production_encryption(&event));
  assert(s_status.authenticated && s_status.ready && !terminated);
}
static void test_unknown_peer_and_window_exit(void) {
  reset(); struct mock_event event={.connect={.conn_handle=1,.status=0}};
  assert(!production_connect(&event)); assert(terminated==1 && !security_requests);
  reset(); peer_known=true; assert(!production_connect(&event));
  assert(!terminated && security_requests==1 && s_status.encrypted && !s_status.authenticated);
  reset(); qdd_ble_pairing_context(true); peer.sec_state.encrypted=false; peer.sec_state.bonded=false;
  assert(!production_connect(&event)); assert(!terminated && security_requests==1);
  qdd_ble_pairing_context(false); assert(terminated==1);
  reset(); event.connect.status=1; assert(!production_connect(&event));
  assert(reset_calls==1 && advertising_requests==1 && !security_requests && !terminated);
}
static void test_primary_name_and_stale_passkey(void) {
  reset(); assert(!advertise());
  assert(captured_advertisement.name_is_complete && captured_advertisement.name_len==17);
  assert(!memcmp(captured_advertisement.name,s_name,17));
  struct mock_event event={.passkey={.conn_handle=1,.params={.action=1}}};
  s_status.passkey_visible=true; s_status.passkey=123456;
  assert(!production_passkey(&event)); assert(terminated==1 && !s_status.passkey_visible && !s_status.passkey);
  event.passkey.params.action=BLE_SM_IOACT_NONE; assert(!production_passkey(&event)); assert(terminated==1);
}
static void test_negotiated_key_size_is_required_for_custom_hid_and_text(void) {
  const uint8_t key_sizes[]={7,15,16};
  for (size_t index=0;index<sizeof(key_sizes);index++) {
    reset(); qdd_ble_pairing_context(true); s_new_peer=true;
    peer.sec_state.key_size=key_sizes[index];
    const bool accepted=key_sizes[index]==16;
    struct mock_event event={.enc_change={.conn_handle=1,.status=0}};
    assert(!production_encryption(&event));
    assert(s_status.encrypted && s_status.bonded && !s_status.authenticated);
    assert(s_status.key_size==key_sizes[index] && s_status.ready==accepted);
    assert(s_status.consumer_ready==accepted && terminated==!accepted);
    assert(s_status.pairing_open==!accepted);
    const uint8_t movement[4]={0,1,0,0};
    assert(qdd_ble_report(QDD_REPORT_MOUSE,movement,sizeof(movement),NULL)==accepted);
    assert(reports==(unsigned)accepted);
    struct ble_gatt_access_ctxt read={.op=BLE_GATT_ACCESS_OP_READ_CHR};
    assert(text_access(1,0,&read,NULL)==(accepted ? 0 : BLE_ATT_ERR_INSUFFICIENT_AUTHEN));
  }
}
int main(void) {
  test_just_works_security_and_reports(); test_unknown_peer_and_window_exit(); test_primary_name_and_stale_passkey();
  test_negotiated_key_size_is_required_for_custom_hid_and_text();
  puts("Actual BLE Just Works, encrypted/bonded gates, GAP window, primary name and no stale PIN: PASS"); return 0;
}
