#pragma once
#include "qdd_net_config.h"
#include "esp_err.h"

#define QDD_WIFI_SCAN_LIMIT 64
typedef struct { char ssid[33]; int8_t rssi; uint8_t bssid[6]; bool open; } qdd_wifi_ap_t;
typedef struct {
    bool configured, connected, connecting, scanning, failed;
    char ip[16];
    uint16_t port;
    uint8_t count;
    uint32_t scan_revision;
} qdd_wifi_view_t;

esp_err_t qdd_wifi_start(void);
esp_err_t qdd_wifi_scan(void);
void qdd_wifi_allow_reconnect(bool enabled);
esp_err_t qdd_wifi_save(const qdd_wifi_credentials_t *credentials);
esp_err_t qdd_wifi_clear(void);
esp_err_t qdd_wifi_retry(void);
void qdd_wifi_poll(uint64_t now_ms);
qdd_wifi_view_t qdd_wifi_view(void);
// Keep task/HTTP snapshots small; copy only a requested scan entry under lock.
bool qdd_wifi_ap(uint8_t index, uint32_t scan_revision, qdd_wifi_ap_t *ap);
bool qdd_wifi_tcp_live(void);
uint32_t qdd_wifi_tcp_epoch(void);
int qdd_wifi_read(uint8_t *bytes, size_t size);
bool qdd_wifi_write(const char *bytes, size_t size);
void qdd_wifi_close_client(void);
