#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

typedef struct { int unused; } wifi_init_config_t;
#define WIFI_INIT_CONFIG_DEFAULT() ((wifi_init_config_t){0})
#define WIFI_PS_MIN_MODEM 1
#define WIFI_PS_NONE 0
#define WIFI_STORAGE_RAM 1
#define WIFI_REASON_ASSOC_LEAVE 8
typedef struct { uint8_t reason; } wifi_event_sta_disconnected_t;
#define WIFI_MODE_STA 1
#define WIFI_IF_STA 1
#define WIFI_AUTH_OPEN 0
#define WIFI_AUTH_WPA2_PSK 3
typedef struct {
    struct {
        uint8_t ssid[32];
        uint8_t password[64];
        struct { int authmode; } threshold;
        struct { bool capable, required; } pmf_cfg;
    } sta;
} wifi_config_t;
typedef struct {
    uint8_t ssid[33];
    uint8_t bssid[6];
    int8_t rssi;
    int authmode;
} wifi_ap_record_t;
typedef struct {
    uint8_t *ssid, *bssid;
    uint8_t channel;
    bool show_hidden;
    struct { struct { uint32_t min, max; } active; } scan_time;
} wifi_scan_config_t;

esp_err_t esp_wifi_init(const wifi_init_config_t *config);
esp_err_t esp_wifi_deinit(void);
esp_err_t esp_wifi_set_storage(int storage);
esp_err_t esp_wifi_set_country_code(const char *country, bool ieee80211d_enabled);
esp_err_t esp_wifi_set_mode(int mode);
esp_err_t esp_wifi_start(void);
esp_err_t esp_wifi_stop(void);
esp_err_t esp_wifi_set_ps(int mode);
esp_err_t esp_wifi_disconnect(void);
esp_err_t esp_wifi_set_config(int interface, const wifi_config_t *config);
esp_err_t esp_wifi_connect(void);
esp_err_t esp_wifi_scan_start(const wifi_scan_config_t *config, bool block);
esp_err_t esp_wifi_scan_get_ap_num(uint16_t *count);
esp_err_t esp_wifi_scan_get_ap_record(wifi_ap_record_t *record);
esp_err_t esp_wifi_clear_ap_list(void);
