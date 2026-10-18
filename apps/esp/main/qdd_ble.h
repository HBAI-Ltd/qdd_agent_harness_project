#pragma once

#include "esp_err.h"
#include "qdd_hid.h"

typedef struct {
  bool connected;
  bool encrypted;
  bool authenticated; // Actual MITM flag; false is expected for Just Works.
  bool bonded;
  uint8_t key_size; // Actual negotiated encryption key length in bytes.
  bool ready;
  bool consumer_ready;
  bool pairing_open;
  bool passkey_visible;
  uint32_t passkey;
  uint32_t link_epoch;
} qdd_ble_status_t;

esp_err_t qdd_ble_start(void);
const char *qdd_ble_name(void);
qdd_ble_status_t qdd_ble_status(void);
void qdd_ble_open_pairing(void);
// Main-loop context: guide step four / Bluetooth settings. Never erases bonds.
void qdd_ble_pairing_context(bool active);
void qdd_ble_poll(void);
// Presentation task publishes its cached sample; GATT callbacks never read I2C.
void qdd_ble_set_battery(int percent);
bool qdd_ble_report(uint8_t report_id, const uint8_t *data, size_t length, void *context);

// Numeric events only; the main control worker owns the text state machine.
// One indication may be in flight. Tokenized confirmations ignore stale work.
typedef struct {
  bool editor_changed, ready, ack_received, indication_done, indication_success;
  uint32_t editor_epoch, ack_epoch, indication_token;
  uint64_t ack_id;
  uint8_t ack_status;
} qdd_ble_text_events_t;
typedef enum { QDD_BLE_TEXT_QUEUED, QDD_BLE_TEXT_BUSY, QDD_BLE_TEXT_FAILED } qdd_ble_text_send_t;
qdd_ble_text_events_t qdd_ble_text_events(void);
uint16_t qdd_ble_text_mtu(void);
void qdd_ble_text_cancel_pending(void);
qdd_ble_text_send_t qdd_ble_text_indicate(const uint8_t *bytes, size_t length,
    uint64_t deadline_ms, bool (*allowed)(void), uint32_t *token);
