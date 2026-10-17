#pragma once
#include "esp_err.h"
#include <stdint.h>
typedef struct { int8_t rssi; uint8_t primary; } wifi_ap_record_t;
typedef enum { WIFI_PS_NONE, WIFI_PS_MIN_MODEM, WIFI_PS_MAX_MODEM } wifi_ps_type_t;
esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *record);
esp_err_t esp_wifi_get_ps(wifi_ps_type_t *mode);
