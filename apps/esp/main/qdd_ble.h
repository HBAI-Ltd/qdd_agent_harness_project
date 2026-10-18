#pragma once

#include "esp_err.h"
#include "qdd_hid.h"

typedef struct {
  bool connected;
  bool encrypted;
  bool authenticated;
  bool bonded;
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
