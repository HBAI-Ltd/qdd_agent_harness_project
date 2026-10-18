// Application-owned HOGP GATT service on ESP-IDF NimBLE; one Bluetooth host.
#include "qdd_ble.h"
#include "qdd_ble_policy.h"

#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_sm.h"
#include "host/ble_store.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nvs_flash.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include <stdio.h>
#include <stdatomic.h>
#include <string.h>

#define REPORT_MODE 1

// Standard HID report descriptors: relative 3-button mouse with wheel, boot
// compatible 6-key keyboard, and one 16-bit Consumer usage (e.g. AC Home/Back).
static const uint8_t s_report_map[] = {
  0x05,0x01, 0x09,0x02, 0xA1,0x01, 0x85,QDD_REPORT_MOUSE,
  0x09,0x01, 0xA1,0x00, 0x05,0x09, 0x19,0x01, 0x29,0x03,
  0x15,0x00, 0x25,0x01, 0x95,0x03, 0x75,0x01, 0x81,0x02,
  0x95,0x01, 0x75,0x05, 0x81,0x03,
  0x05,0x01, 0x09,0x30, 0x09,0x31, 0x09,0x38,
  0x15,0x81, 0x25,0x7F, 0x75,0x08, 0x95,0x03, 0x81,0x06, 0xC0,0xC0,
  0x05,0x01, 0x09,0x06, 0xA1,0x01, 0x85,QDD_REPORT_KEYBOARD,
  0x05,0x07, 0x19,0xE0, 0x29,0xE7, 0x15,0x00, 0x25,0x01,
  0x75,0x01, 0x95,0x08, 0x81,0x02,
  0x75,0x08, 0x95,0x01, 0x81,0x03,
  0x95,0x05, 0x75,0x01, 0x05,0x08, 0x19,0x01, 0x29,0x05, 0x91,0x02,
  0x95,0x01, 0x75,0x03, 0x91,0x03,
  0x95,0x06, 0x75,0x08, 0x15,0x00, 0x26,0xFF,0x00,
  0x05,0x07, 0x19,0x00, 0x2A,0xFF,0x00, 0x81,0x00, 0xC0,
  0x05,0x0C, 0x09,0x01, 0xA1,0x01, 0x85,QDD_REPORT_CONSUMER,
  0x15,0x00, 0x27,0xFF,0xFF,0x00,0x00,
  0x19,0x00, 0x2A,0xFF,0xFF, 0x75,0x10, 0x95,0x01, 0x81,0x00, 0xC0
};
static char s_name[24];
static uint8_t s_address_type;
static atomic_uint_fast16_t s_connection = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_input_handles[2][4];
static qdd_hid_subscriptions_t s_subscriptions;
static qdd_ble_policy_t s_policy;
static atomic_bool s_new_peer;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static qdd_ble_status_t s_status;
static bool s_suspended;
static uint8_t s_keyboard_leds;
static atomic_int s_battery = -1;
static uint8_t s_pnp_id[7];
static uint16_t s_text_handle;
static bool s_text_subscribed, s_text_indication_busy, s_text_requested, s_att_indication_busy;
static bool s_text_cancelled, s_text_neutral, s_text_event_enqueued;
static uint8_t s_text_staging[64];
static size_t s_text_length;
static uint64_t s_text_deadline;
static bool (*s_text_allowed)(void);
static struct ble_npl_event s_text_send_event;
static uint32_t s_text_next_token, s_text_flight_token;
static qdd_ble_text_events_t s_text_events;
static const ble_uuid128_t s_text_service = BLE_UUID128_INIT(0x01,0x00,0x0a,0xd0,0xc9,0x25,0xf7,0x8f,0x19,0x4a,0xba,0x39,0x01,0xd2,0xde,0x9b);
static const ble_uuid128_t s_text_indication = BLE_UUID128_INIT(0x02,0x00,0x0a,0xd0,0xc9,0x25,0xf7,0x8f,0x19,0x4a,0xba,0x39,0x01,0xd2,0xde,0x9b);
static const ble_uuid128_t s_text_write = BLE_UUID128_INIT(0x03,0x00,0x0a,0xd0,0xc9,0x25,0xf7,0x8f,0x19,0x4a,0xba,0x39,0x01,0xd2,0xde,0x9b);

void ble_store_config_init(void);
static int gap_event(struct ble_gap_event *event, void *argument);
static void on_reset(int reason);
static void reset_link(void);
static void text_send_event(struct ble_npl_event *event);

static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000u; }

const char *qdd_ble_name(void) { return s_name; }

qdd_ble_status_t qdd_ble_status(void) {
  portENTER_CRITICAL(&s_lock);
  qdd_ble_status_t status = s_status;
  portEXIT_CRITICAL(&s_lock);
  return status;
}

// Caller holds s_lock. Just Works preserves encryption and bonding without a
// MITM-authenticated flag. Android must also enable both Input Report CCCDs.
static void update_ready_locked(void) {
  const bool secure = s_status.connected && s_status.encrypted &&
                      s_status.bonded && s_status.key_size == 16 && !s_suspended;
  s_status.ready = secure && qdd_hid_subscriptions_ready(&s_subscriptions);
  s_status.consumer_ready = secure &&
    qdd_hid_subscriptions_notifying(&s_subscriptions, QDD_REPORT_CONSUMER);
}

typedef struct { const uint8_t *data; size_t length; } gatt_blob_t;
static const uint8_t s_zero[8];
static const uint8_t s_hid_info[] = {0x11, 0x01, 0x00, 0x02};
static const uint8_t s_references[][2] = {{0,0}, {1,1}, {2,1}, {3,1}, {2,2}};
static const gatt_blob_t s_input_blobs[] = {{s_zero,0}, {s_zero,4}, {s_zero,8}, {s_zero,2}};
static const gatt_blob_t s_ref_blobs[] = {
  {s_references[0],2}, {s_references[1],2}, {s_references[2],2},
  {s_references[3],2}, {s_references[4],2}
};
static const gatt_blob_t s_map_blob = {s_report_map, sizeof(s_report_map)};
static const gatt_blob_t s_info_blob = {s_hid_info, sizeof(s_hid_info)};
static const gatt_blob_t s_boot_mouse_blob = {s_zero, 3};
static const gatt_blob_t s_pnp_blob = {s_pnp_id, sizeof(s_pnp_id)};

void qdd_ble_set_battery(int percent) {
  atomic_store(&s_battery, percent >= 0 && percent <= 100 ? percent : -1);
}

static int battery_access(uint16_t connection, uint16_t handle,
                           struct ble_gatt_access_ctxt *context, void *argument) {
  (void)connection;
  (void)handle;
  (void)argument;
  if (context->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
  const int sample = atomic_load(&s_battery);
  if (sample < 0) return BLE_ATT_ERR_UNLIKELY; // No valid cached battery sample.
  const uint8_t level = (uint8_t)sample;
  return os_mbuf_append(context->om, &level, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int blob_access(uint16_t connection, uint16_t handle,
                        struct ble_gatt_access_ctxt *context, void *argument) {
  (void)connection;
  (void)handle;
  const gatt_blob_t *blob = argument;
  if (context->op != BLE_GATT_ACCESS_OP_READ_CHR &&
      context->op != BLE_GATT_ACCESS_OP_READ_DSC) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
  return os_mbuf_append(context->om, blob->data, blob->length) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int mode_access(uint16_t connection, uint16_t handle,
                        struct ble_gatt_access_ctxt *context, void *argument) {
  (void)connection;
  (void)handle;
  const bool control_point = (uintptr_t)argument == 1;
  if (context->op == BLE_GATT_ACCESS_OP_READ_CHR && !control_point) {
    portENTER_CRITICAL(&s_lock);
    const uint8_t mode = s_subscriptions.protocol_mode;
    portEXIT_CRITICAL(&s_lock);
    return os_mbuf_append(context->om, &mode, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
  }
  uint8_t value;
  if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
  if (OS_MBUF_PKTLEN(context->om) != 1 || ble_hs_mbuf_to_flat(context->om, &value, 1, NULL) != 0) {
    return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
  }
  if (value > 1) return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
  portENTER_CRITICAL(&s_lock);
  if (control_point) {
    if (s_suspended != (value == 0)) s_status.link_epoch++;
    s_suspended = value == 0;
  } else {
    if (s_subscriptions.protocol_mode != value) s_status.link_epoch++;
    s_subscriptions.protocol_mode = value;
  }
  update_ready_locked();
  portEXIT_CRITICAL(&s_lock);
  return 0;
}

// Caller holds s_lock. Disconnects invalidate pending numeric events and
// subscriptions; no callback retains packet text or accesses the controller.
static void text_reset_locked(void) {
  s_text_subscribed = false;
  s_text_indication_busy = false;
  s_text_flight_token = 0;
  s_text_requested = s_att_indication_busy = s_text_cancelled = s_text_neutral = false;
  s_text_length = 0; memset(s_text_staging, 0, sizeof(s_text_staging));
  s_text_allowed = NULL;
  s_text_events = (qdd_ble_text_events_t){.editor_changed = true};
}

static uint64_t text_little(const uint8_t *bytes, unsigned count) {
  uint64_t value = 0;
  for (unsigned i = 0; i < count; i++) value |= (uint64_t)bytes[i] << (i * 8);
  return value;
}

static int text_access(uint16_t connection, uint16_t handle,
                       struct ble_gatt_access_ctxt *context, void *argument) {
  (void)handle;
  const qdd_ble_status_t status = qdd_ble_status();
  if (connection != atomic_load(&s_connection) || !status.connected || !status.encrypted ||
      !status.bonded || status.key_size != 16) return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
  if (context->op == BLE_GATT_ACCESS_OP_READ_CHR && argument == NULL) return 0;
  if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR || argument == NULL) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
  const size_t length = OS_MBUF_PKTLEN(context->om);
  uint8_t frame[15];
  if ((length != 6 && length != 15) || ble_hs_mbuf_to_flat(context->om, frame, length, NULL) != 0 || frame[0] != 1) {
    return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
  }
  if ((frame[1] == 0x81 || frame[1] == 0x83) && length == 6) {
    const uint32_t epoch = (uint32_t)text_little(frame + 2, 4);
    if (!epoch) return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    portENTER_CRITICAL(&s_lock);
    const bool allowed = frame[1] != 0x81 || s_text_subscribed;
    if (allowed) {
      s_text_events.editor_changed = true;
      s_text_events.ready = frame[1] == 0x81;
      s_text_events.editor_epoch = epoch;
    }
    portEXIT_CRITICAL(&s_lock);
    return allowed ? 0 : BLE_ATT_ERR_UNLIKELY;
  }
  if (frame[1] != 0x82 || length != 15 || frame[10] > 2) return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
  const uint64_t id = text_little(frame + 2, 8);
  const uint32_t epoch = (uint32_t)text_little(frame + 11, 4);
  if (!id || !epoch) return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
  portENTER_CRITICAL(&s_lock);
  s_text_events.ack_received = true;
  s_text_events.ack_id = id;
  s_text_events.ack_epoch = epoch;
  s_text_events.ack_status = frame[10];
  portEXIT_CRITICAL(&s_lock);
  return 0;
}

static int led_access(uint16_t connection, uint16_t handle,
                       struct ble_gatt_access_ctxt *context, void *argument) {
  (void)connection;
  (void)handle;
  (void)argument;
  if (context->op == BLE_GATT_ACCESS_OP_READ_CHR) {
    return os_mbuf_append(context->om, &s_keyboard_leds, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
  }
  if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
  if (OS_MBUF_PKTLEN(context->om) != 1 ||
      ble_hs_mbuf_to_flat(context->om, &s_keyboard_leds, 1, NULL) != 0) {
    return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
  }
  return 0;
}

#define SECURE_READ (BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC)
#define SECURE_WRITE (BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_WRITE_ENC)
#define SECURE_NOTIFY (SECURE_READ | BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_NOTIFY_INDICATE_ENC)
#define REPORT_REFERENCE(index) (struct ble_gatt_dsc_def[]) { \
  {.uuid = BLE_UUID16_DECLARE(0x2908), .access_cb = blob_access, \
   .att_flags = BLE_ATT_F_READ | BLE_ATT_F_READ_ENC, .min_key_size = 16, \
   .arg = (void *)&s_ref_blobs[index]}, {0} }
#define INPUT_REPORT(index) \
  {.uuid = BLE_UUID16_DECLARE(0x2A4D), .access_cb = blob_access, \
   .flags = SECURE_NOTIFY, .min_key_size = 16, .arg = (void *)&s_input_blobs[index], \
   .val_handle = &s_input_handles[1][index], .descriptors = REPORT_REFERENCE(index)}

// Own the public GATT definitions and GAP callback. In particular, do not
// instantiate esp_hidd's private legacy listener: its failed-CONNECT path calls
// conn_find on a nonexistent connection and asserts in ESP-IDF 5.5.3.
static const struct ble_gatt_svc_def s_services[] = {
  {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = BLE_UUID16_DECLARE(0x1812),
   .characteristics = (struct ble_gatt_chr_def[]) {
    {.uuid = BLE_UUID16_DECLARE(0x2A4A), .access_cb = blob_access,
     .flags = SECURE_READ, .arg = (void *)&s_info_blob, .min_key_size = 16},
    {.uuid = BLE_UUID16_DECLARE(0x2A4B), .access_cb = blob_access,
     .flags = SECURE_READ, .arg = (void *)&s_map_blob, .min_key_size = 16},
    {.uuid = BLE_UUID16_DECLARE(0x2A4E), .access_cb = mode_access,
     .flags = SECURE_READ | SECURE_WRITE, .min_key_size = 16},
    {.uuid = BLE_UUID16_DECLARE(0x2A4C), .access_cb = mode_access,
     .flags = SECURE_WRITE, .arg = (void *)1, .min_key_size = 16},
    INPUT_REPORT(QDD_REPORT_MOUSE), INPUT_REPORT(QDD_REPORT_KEYBOARD), INPUT_REPORT(QDD_REPORT_CONSUMER),
    {.uuid = BLE_UUID16_DECLARE(0x2A4D), .access_cb = led_access,
     .flags = SECURE_READ | SECURE_WRITE | BLE_GATT_CHR_F_WRITE,
     .min_key_size = 16, .descriptors = REPORT_REFERENCE(4)},
    {.uuid = BLE_UUID16_DECLARE(0x2A33), .access_cb = blob_access,
     .flags = SECURE_NOTIFY, .arg = (void *)&s_boot_mouse_blob,
     .val_handle = &s_input_handles[0][QDD_REPORT_MOUSE], .min_key_size = 16},
    {.uuid = BLE_UUID16_DECLARE(0x2A22), .access_cb = blob_access,
     .flags = SECURE_NOTIFY, .arg = (void *)&s_input_blobs[QDD_REPORT_KEYBOARD],
     .val_handle = &s_input_handles[0][QDD_REPORT_KEYBOARD], .min_key_size = 16},
    {.uuid = BLE_UUID16_DECLARE(0x2A32), .access_cb = led_access,
     .flags = SECURE_READ | SECURE_WRITE | BLE_GATT_CHR_F_WRITE, .min_key_size = 16},
    {0}
   }},
  {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = BLE_UUID16_DECLARE(0x180F),
   .characteristics = (struct ble_gatt_chr_def[]) {
    {.uuid = BLE_UUID16_DECLARE(0x2A19), .access_cb = battery_access,
     .flags = BLE_GATT_CHR_F_READ},
    {0}
   }},
  {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = BLE_UUID16_DECLARE(0x180A),
   .characteristics = (struct ble_gatt_chr_def[]) {
    {.uuid = BLE_UUID16_DECLARE(0x2A50), .access_cb = blob_access,
     .flags = BLE_GATT_CHR_F_READ, .arg = (void *)&s_pnp_blob},
    {0}
   }},
  // Append only: existing HID/Battery/Device Information handles retain
  // their registration order for already bonded Android HID clients.
  {.type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &s_text_service.u,
   .characteristics = (struct ble_gatt_chr_def[]) {
    {.uuid = &s_text_indication.u, .access_cb = text_access,
     .flags = SECURE_READ | BLE_GATT_CHR_F_INDICATE | BLE_GATT_CHR_F_NOTIFY_INDICATE_ENC,
     .min_key_size = 16, .val_handle = &s_text_handle},
    {.uuid = &s_text_write.u, .access_cb = text_access, .arg = (void *)1,
     .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC,
     .min_key_size = 16},
    {0}
   }},
  {0}
};

static bool known_peer(const ble_addr_t *address) {
  ble_addr_t peers[CONFIG_BT_NIMBLE_MAX_BONDS];
  int count = 0;
  if (ble_store_util_bonded_peers(peers, &count, CONFIG_BT_NIMBLE_MAX_BONDS) != 0) return false;
  for (int i = 0; i < count; i++) {
    if (peers[i].type == address->type && memcmp(peers[i].val, address->val, 6) == 0) return true;
  }
  return false;
}

void qdd_ble_open_pairing(void) {
  portENTER_CRITICAL(&s_lock);
  qdd_ble_policy_open(&s_policy, now_ms());
  s_status.pairing_open = s_policy.pairing_open;
  portEXIT_CRITICAL(&s_lock);
}

void qdd_ble_pairing_context(bool active) {
  portENTER_CRITICAL(&s_lock);
  const bool was_open = s_policy.pairing_open;
  const bool secure = s_status.connected && s_status.encrypted &&
                      s_status.bonded && s_status.key_size == 16;
  qdd_ble_policy_context(&s_policy, active, secure, now_ms());
  s_status.pairing_open = s_policy.pairing_open;
  const bool closed = was_open && !s_policy.pairing_open;
  if (closed) s_status.passkey_visible = false;
  const bool terminate = closed && !secure;
  portEXIT_CRITICAL(&s_lock);
  const uint16_t connection = atomic_load(&s_connection);
  if (terminate && atomic_load(&s_new_peer) && connection != BLE_HS_CONN_HANDLE_NONE) {
    (void)ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
  }
}

static void request_advertising(void) {
  portENTER_CRITICAL(&s_lock);
  qdd_ble_policy_advertise(&s_policy, now_ms());
  portEXIT_CRITICAL(&s_lock);
}

static int advertise(void) {
  static ble_uuid16_t hid_uuid = BLE_UUID16_INIT(0x1812);
  struct ble_hs_adv_fields fields = {0};
  fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
  fields.appearance = 0x03C0; // Generic HID; Report Map declares keyboard + mouse.
  fields.appearance_is_present = 1;
  fields.uuids16 = &hid_uuid;
  fields.num_uuids16 = 1;
  fields.uuids16_is_complete = 1;
  // Flags (3) + appearance (4) + HID UUID (4) + full 17-byte name (19)
  // fit the 31-byte primary advertisement, including passive phone scans.
  fields.name = (const uint8_t *)s_name;
  fields.name_len = strlen(s_name);
  fields.name_is_complete = 1;
  int rc = ble_gap_adv_set_fields(&fields);
  if (rc != 0) return rc;
  struct ble_hs_adv_fields scan = {0};
  rc = ble_gap_adv_rsp_set_fields(&scan);
  if (rc != 0) return rc;
  struct ble_gap_adv_params params = {0};
  params.conn_mode = BLE_GAP_CONN_MODE_UND;
  params.disc_mode = BLE_GAP_DISC_MODE_GEN;
  return ble_gap_adv_start(s_address_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
}

static void update_security(uint16_t connection) {
  struct ble_gap_conn_desc desc;
  if (ble_gap_conn_find(connection, &desc) != 0) return;
  portENTER_CRITICAL(&s_lock);
  s_status.connected = true;
  s_status.encrypted = desc.sec_state.encrypted;
  s_status.authenticated = desc.sec_state.authenticated;
  s_status.bonded = desc.sec_state.bonded;
  s_status.key_size = desc.sec_state.key_size;
  update_ready_locked();
  if (s_status.encrypted && s_status.bonded && s_status.key_size == 16) {
    s_status.passkey_visible = false;
    if (s_new_peer) {
      qdd_ble_policy_secure(&s_policy);
      s_status.pairing_open = false;
    }
  }
  portEXIT_CRITICAL(&s_lock);
}

static int gap_event(struct ble_gap_event *event, void *argument) {
  (void)argument;
  switch (event->type) {
    case BLE_GAP_EVENT_CONNECT: {
      if (event->connect.status != 0) {
        reset_link();
        request_advertising();
        return 0;
      }
      s_connection = event->connect.conn_handle;
      portENTER_CRITICAL(&s_lock);
      s_status.link_epoch++;
      s_suspended = false;
      qdd_hid_subscriptions_reset(&s_subscriptions);
      text_reset_locked();
      update_ready_locked();
      portEXIT_CRITICAL(&s_lock);
      struct ble_gap_conn_desc desc;
      if (ble_gap_conn_find(s_connection, &desc) != 0) return 0;
      s_new_peer = !known_peer(&desc.peer_id_addr);
      if (s_new_peer && !qdd_ble_status().pairing_open) {
        (void)ble_gap_terminate(s_connection, BLE_ERR_REM_USER_CONN_TERM);
        return 0;
      }
      update_security(s_connection);
      const int rc = ble_gap_security_initiate(s_connection);
      if (rc != 0 && rc != BLE_HS_EALREADY) {
        (void)ble_gap_terminate(s_connection, BLE_ERR_REM_USER_CONN_TERM);
      }
      return 0;
    }
    case BLE_GAP_EVENT_ENC_CHANGE: {
      update_security(event->enc_change.conn_handle);
      const qdd_ble_status_t status = qdd_ble_status();
      if (event->enc_change.status != 0 ||
          !status.connected || !status.encrypted || !status.bonded || status.key_size != 16) {
        (void)ble_gap_terminate(event->enc_change.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
      }
      return 0;
    }
    case BLE_GAP_EVENT_PASSKEY_ACTION: {
      portENTER_CRITICAL(&s_lock);
      s_status.passkey = 0;
      s_status.passkey_visible = false;
      portEXIT_CRITICAL(&s_lock);
      // No-input/no-output pairing cannot satisfy a numeric/OOB challenge.
      // Do not invent confirmation or leave a stale code on the display.
      if (event->passkey.params.action != BLE_SM_IOACT_NONE) {
        (void)ble_gap_terminate(event->passkey.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
      }
      return 0;
    }
    case BLE_GAP_EVENT_REPEAT_PAIRING:
      // Never silently delete a stored bond. The phone must retain its keys.
      return BLE_GAP_REPEAT_PAIRING_IGNORE;
    case BLE_GAP_EVENT_SUBSCRIBE:
      if (event->subscribe.conn_handle != atomic_load(&s_connection)) return 0;
      portENTER_CRITICAL(&s_lock);
      if (event->subscribe.attr_handle == s_text_handle) {
        s_text_subscribed = event->subscribe.cur_indicate != 0;
        if (!s_text_subscribed) {
          s_text_events.editor_changed = true; s_text_events.ready = false;
          s_text_events.editor_epoch = 0;
        }
      }
      for (uint8_t mode = 0; mode < 2; mode++) {
        for (uint8_t report = 1; report <= 3; report++) {
          if (s_input_handles[mode][report] != 0 &&
              s_input_handles[mode][report] == event->subscribe.attr_handle) {
            qdd_hid_subscriptions_set(&s_subscriptions, mode, report,
                                      event->subscribe.cur_notify != 0);
          }
        }
      }
      update_ready_locked();
      portEXIT_CRITICAL(&s_lock);
      return 0;
    case BLE_GAP_EVENT_NOTIFY_TX: {
      if (event->notify_tx.conn_handle != atomic_load(&s_connection) || !event->notify_tx.indication) return 0;
      portENTER_CRITICAL(&s_lock);
      // Service Changed and text share the connection's one ATT indication slot.
      // Only EDONE confirms/relinquishes the ATT handle. SDK timeout/error
      // callbacks may precede asynchronous DISCONNECT with it still owned.
      s_att_indication_busy = event->notify_tx.status != BLE_HS_EDONE;
      if (event->notify_tx.attr_handle == s_text_handle && event->notify_tx.status != 0 && s_text_indication_busy) {
        s_text_events.indication_done = true;
        s_text_events.indication_success = event->notify_tx.status == BLE_HS_EDONE;
        s_text_events.indication_token = s_text_flight_token;
        s_text_indication_busy = false;
        s_text_requested = false;
        s_text_length = 0; memset(s_text_staging, 0, sizeof(s_text_staging));
      }
      const bool pump = !s_att_indication_busy && s_text_requested && !s_text_event_enqueued;
      if (pump) s_text_event_enqueued = true;
      portEXIT_CRITICAL(&s_lock);
      if (pump) ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &s_text_send_event);
      return 0;
    }
    case BLE_GAP_EVENT_DISCONNECT:
      s_connection = BLE_HS_CONN_HANDLE_NONE;
      portENTER_CRITICAL(&s_lock);
      s_status.link_epoch++;
      s_status.connected = false;
      s_status.encrypted = false;
      s_status.authenticated = false;
      s_status.bonded = false;
      s_status.key_size = 0;
      s_status.passkey_visible = false;
      qdd_hid_subscriptions_reset(&s_subscriptions);
      text_reset_locked();
      update_ready_locked();
      portEXIT_CRITICAL(&s_lock);
      request_advertising();
      return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
      request_advertising();
      return 0;
    default: return 0;
  }
}

static void on_sync(void) {
  if (ble_hs_util_ensure_addr(0) != 0 || ble_hs_id_infer_auto(0, &s_address_type) != 0) return;
  portENTER_CRITICAL(&s_lock);
  s_policy.host_synced = true;
  portEXIT_CRITICAL(&s_lock);
  ble_addr_t peers[CONFIG_BT_NIMBLE_MAX_BONDS];
  int count = 0;
  if (ble_store_util_bonded_peers(peers, &count, CONFIG_BT_NIMBLE_MAX_BONDS) == 0 && !count) {
    qdd_ble_open_pairing();
  }
  ble_svc_gatt_changed(1, 0xffff);
  request_advertising();
}

static void reset_link(void) {
  portENTER_CRITICAL(&s_lock);
  s_status.link_epoch++;
  s_status.connected = false;
  s_status.encrypted = false;
  s_status.authenticated = false;
  s_status.bonded = false;
  s_status.key_size = 0;
  s_status.passkey_visible = false;
  qdd_hid_subscriptions_reset(&s_subscriptions);
  text_reset_locked();
  update_ready_locked();
  portEXIT_CRITICAL(&s_lock);
  atomic_store(&s_connection, BLE_HS_CONN_HANDLE_NONE);
}

static void on_reset(int reason) {
  (void)reason;
  reset_link();
  portENTER_CRITICAL(&s_lock);
  s_policy.host_synced = false;
  portEXIT_CRITICAL(&s_lock);
}

static void host_task(void *argument) {
  (void)argument;
  nimble_port_run();
  vTaskDelete(NULL);
}

esp_err_t qdd_ble_start(void) {
  qdd_hid_subscriptions_reset(&s_subscriptions);
  if (!qdd_hid_pnp_id(s_pnp_id, CONFIG_QDD_HID_VENDOR_ID_SOURCE,
                      CONFIG_QDD_HID_VENDOR_ID, CONFIG_QDD_HID_PRODUCT_ID,
                      CONFIG_QDD_HID_PRODUCT_VERSION)) return ESP_ERR_INVALID_ARG;
  // Preserve NVS and existing bonds on every failure; no erase/retry shortcut.
  esp_err_t error = nvs_flash_init();
  if (error != ESP_OK) return error;
  uint8_t address[6];
  error = esp_read_mac(address, ESP_MAC_BT);
  if (error != ESP_OK) return error;
  (void)snprintf(s_name, sizeof(s_name), "QDD-Passport-%02X%02X", address[4], address[5]);
  error = nimble_port_init();
  if (error != ESP_OK) return error;
  ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
  ble_hs_cfg.sm_bonding = 1;
  ble_hs_cfg.sm_mitm = 0;
  ble_hs_cfg.sm_sc = 1;
  ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ID | BLE_SM_PAIR_KEY_DIST_ENC;
  ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ID | BLE_SM_PAIR_KEY_DIST_ENC;
  // No round-robin store callback: a full bond store must not evict an owner.
  ble_store_config_init();
  ble_svc_gap_init();
  ble_svc_gatt_init();
  if (ble_gatts_count_cfg(s_services) != 0 || ble_gatts_add_svcs(s_services) != 0) {
    return ESP_FAIL;
  }
  ble_npl_event_init(&s_text_send_event, text_send_event, NULL);
  ble_hs_cfg.sync_cb = on_sync;
  ble_hs_cfg.reset_cb = on_reset;
  (void)ble_svc_gap_device_name_set(s_name);
  (void)ble_svc_gap_device_appearance_set(0x03C0);
  if (xTaskCreate(host_task, "qdd_ble", 4096, NULL, 5, NULL) != pdPASS) {
    return ESP_ERR_NO_MEM;
  }
  return ESP_OK;
}

void qdd_ble_poll(void) {
  const uint64_t now = now_ms();
  portENTER_CRITICAL(&s_lock);
  const bool expired = qdd_ble_policy_expire(&s_policy, now);
  s_status.pairing_open = s_policy.pairing_open;
  if (expired) {
    s_status.passkey_visible = false;
  }
  const bool retry = s_policy.host_synced && s_policy.advertise_pending &&
                     now >= s_policy.advertise_at;
  const bool secure = s_status.connected && s_status.encrypted && s_status.bonded && s_status.key_size == 16;
  portEXIT_CRITICAL(&s_lock);
  if (expired && s_new_peer && s_connection != BLE_HS_CONN_HANDLE_NONE &&
      !secure) {
    (void)ble_gap_terminate(s_connection, BLE_ERR_REM_USER_CONN_TERM);
  }
  if (retry && atomic_load(&s_connection) == BLE_HS_CONN_HANDLE_NONE) {
    const bool active = ble_gap_adv_active() != 0;
    portENTER_CRITICAL(&s_lock);
    const bool due = qdd_ble_policy_advertise_due(&s_policy,
        atomic_load(&s_connection) != BLE_HS_CONN_HANDLE_NONE, active, now);
    portEXIT_CRITICAL(&s_lock);
    if (due && advertise() != 0) {
      portENTER_CRITICAL(&s_lock);
      qdd_ble_policy_advertise_failed(&s_policy);
      portEXIT_CRITICAL(&s_lock);
    }
  }
}

qdd_ble_text_events_t qdd_ble_text_events(void) {
  portENTER_CRITICAL(&s_lock);
  const qdd_ble_text_events_t events = s_text_events;
  s_text_events.editor_changed = s_text_events.ack_received = s_text_events.indication_done = false;
  portEXIT_CRITICAL(&s_lock);
  return events;
}

uint16_t qdd_ble_text_mtu(void) {
  const uint16_t connection = (uint16_t)atomic_load(&s_connection);
  return connection == BLE_HS_CONN_HANDLE_NONE ? 23 : ble_att_mtu(connection);
}

static void text_send_failed(uint32_t token) {
  portENTER_CRITICAL(&s_lock);
  if (s_text_indication_busy && s_text_flight_token == token) {
    s_text_events.indication_done = true; s_text_events.indication_success = false;
    s_text_events.indication_token = token;
    s_text_indication_busy = s_text_requested = false;
    s_text_length = 0; memset(s_text_staging, 0, sizeof(s_text_staging));
  }
  portEXIT_CRITICAL(&s_lock);
}

// Runs on the public NimBLE host event queue, never concurrently with the
// standard Service Changed sender. No private connection fields are inspected.
static void text_send_event(struct ble_npl_event *event) {
  (void)event;
  uint8_t bytes[64];
  portENTER_CRITICAL(&s_lock);
  s_text_event_enqueued = false;
  if (!s_text_requested || s_att_indication_busy) { portEXIT_CRITICAL(&s_lock); return; }
  const uint32_t token = s_text_flight_token;
  const size_t length = s_text_length;
  const uint64_t deadline = s_text_deadline;
  bool (*allowed)(void) = s_text_allowed;
  memcpy(bytes, s_text_staging, length);
  const bool secure = s_text_subscribed && s_status.connected && s_status.encrypted &&
      s_status.bonded && s_status.key_size == 16 && !s_text_cancelled;
  s_text_requested = false;
  s_text_length = 0; memset(s_text_staging, 0, sizeof(s_text_staging));
  portEXIT_CRITICAL(&s_lock);
  if (!secure || now_ms() > deadline || (allowed && !allowed())) { text_send_failed(token); return; }
  struct os_mbuf *frame = ble_hs_mbuf_from_flat(bytes, length);
  memset(bytes, 0, sizeof(bytes));
  portENTER_CRITICAL(&s_lock);
  const bool cancelled = s_text_cancelled || token != s_text_flight_token;
  portEXIT_CRITICAL(&s_lock);
  if (cancelled || now_ms() > deadline || (allowed && !allowed())) { os_mbuf_free_chain(frame); text_send_failed(token); return; }
  const uint16_t connection = (uint16_t)atomic_load(&s_connection);
  // The SDK consumes the single mbuf on every enabled indication result.
  const int result = frame ? ble_gatts_indicate_custom(connection, s_text_handle, frame) : BLE_HS_ENOMEM;
  if (result != 0) text_send_failed(token);
}

void qdd_ble_text_cancel_pending(void) {
  portENTER_CRITICAL(&s_lock);
  // CANCEL is neutral cleanup, and must survive PAUSE/focus-loss pumps while
  // waiting for the shared ATT slot. Disconnect still resets the whole link.
  if (s_text_neutral) { portEXIT_CRITICAL(&s_lock); return; }
  s_text_cancelled = true;
  const uint32_t token = s_text_flight_token;
  const bool pending = s_text_requested;
  portEXIT_CRITICAL(&s_lock);
  if (pending) text_send_failed(token);
}

qdd_ble_text_send_t qdd_ble_text_indicate(const uint8_t *bytes, size_t length,
    uint64_t deadline_ms, bool (*allowed)(void), uint32_t *token) {
  if (!bytes || !token || !length || length > 64 || length + 3u > qdd_ble_text_mtu()) return QDD_BLE_TEXT_FAILED;
  portENTER_CRITICAL(&s_lock);
  if (!s_status.connected || !s_status.encrypted || !s_status.bonded || s_status.key_size != 16 ||
      !s_text_subscribed || !s_text_handle) { portEXIT_CRITICAL(&s_lock); return QDD_BLE_TEXT_FAILED; }
  if (s_text_indication_busy) { portEXIT_CRITICAL(&s_lock); return QDD_BLE_TEXT_BUSY; }
  s_text_indication_busy = s_text_requested = true; s_text_cancelled = false;
  s_text_neutral = length == 10 && bytes[0] == 1 && bytes[1] == 4;
  if (!++s_text_next_token) ++s_text_next_token;
  *token = s_text_flight_token = s_text_next_token;
  s_text_deadline = deadline_ms; s_text_allowed = allowed;
  memcpy(s_text_staging, bytes, length); s_text_length = length;
  // Main and GAP-confirmation are separate producers. Deduplicate under the
  // application lock before using NPL, whose own queued check is not atomic.
  const bool enqueue = !s_text_event_enqueued;
  if (enqueue) s_text_event_enqueued = true;
  portEXIT_CRITICAL(&s_lock);
  if (enqueue) ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &s_text_send_event);
  return QDD_BLE_TEXT_QUEUED;
}

bool qdd_ble_report(uint8_t report_id, const uint8_t *data, size_t length, void *context) {
  (void)context;
  qdd_ble_poll();
  const qdd_ble_status_t status = qdd_ble_status();
  if (!status.connected || !status.encrypted || !status.bonded || status.key_size != 16) {
    return false;
  }
  bool nonzero = false;
  for (size_t i = 0; i < length; i++) nonzero |= data[i] != 0;
  portENTER_CRITICAL(&s_lock);
  const uint8_t mode = s_subscriptions.protocol_mode;
  const bool subscribed = qdd_hid_subscriptions_notifying(&s_subscriptions, report_id);
  portEXIT_CRITICAL(&s_lock);
  if (!subscribed) return !nonzero; // Neutral release has no recipient.
  if (nonzero && !status.ready) return false;
  // Allocation and missing-report errors fail closed instead of asserting.
  if (report_id < 1 || report_id > 3 || length > 8) return false;
  if (mode != REPORT_MODE && report_id == QDD_REPORT_MOUSE) {
    if (length == 4 && data[3] != 0) return false; // Boot Mouse has no wheel.
    length = 3;
  }
  const uint16_t handle = s_input_handles[mode == REPORT_MODE ? 1 : 0][report_id];
  if (!handle) return false;
  struct os_mbuf *report = ble_hs_mbuf_from_flat(data, length);
  if (!report) return false;
  // notify_custom consumes the mbuf on success and failure.
  return ble_gatts_notify_custom((uint16_t)atomic_load(&s_connection), handle, report) == 0;
}
