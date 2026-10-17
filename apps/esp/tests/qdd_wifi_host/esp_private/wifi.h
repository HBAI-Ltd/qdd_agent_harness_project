#pragma once
#include "esp_wifi.h"
typedef void (*wifi_tx_done_cb_t)(uint8_t, uint8_t *, uint16_t *, bool);
esp_err_t esp_wifi_set_tx_done_cb(wifi_tx_done_cb_t callback);
