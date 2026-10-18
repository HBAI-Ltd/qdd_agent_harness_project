#pragma once
#include "qdd_net_config.h"
#include "esp_err.h"

#define QDD_WIFI_SCAN_LIMIT 64
#define QDD_WIFI_DIAGNOSTICS_MAX 486u
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
// Control worker only. A valid new peer may replace a silent observer, never a TCP owner.
void qdd_wifi_poll(uint64_t now_ms, bool tcp_control_owned);
qdd_wifi_view_t qdd_wifi_view(void);
// Control worker only; ASCII JSON without credentials, no newline. Returns 0
// with an empty output on insufficient capacity/busy. Arrays: rssi/ch/ps=[err,value],
// ev=[connected,disconnected,beaconTimeout,lastReason,disconnectAge,beaconAge],
// heap=[free,minFree,largest], oom=[count,lastSize,lastCaps],
// oomFirst=[allocatorFunction,firstSize,firstCaps], persistent since boot.
// Function: 0=none,1=malloc,2=calloc,3=realloc,4/5/6=malloc/calloc/realloc_prefer,
// 7/8=aligned_alloc/aligned_calloc,9/10=malloc/realloc_default,255=other.
// This identifies the allocator entry only, not its caller or an address.
// tx=[hookErr,ok,fail,lastAge],
// tcp=[epoch,rxBytes,txBytes,fullWrites,failedWrites,rxAge,txAge,lastErrno,lastClose].
// TCP counts are cumulative; fullWrites means accepted by the socket, not delivered.
// lastClose: 0=none,1=external/safety,2=network,3=EOF,4=recv error,5=send failure.
// Successful I/O/accept preserves the last socket failure and close reason.
// Ages are milliseconds; -1 means unavailable. No payload or credentials.
size_t qdd_wifi_diagnostics(char *out, size_t capacity);
// Keep task/HTTP snapshots small; copy only a requested scan entry under lock.
bool qdd_wifi_ap(uint8_t index, uint32_t scan_revision, qdd_wifi_ap_t *ap);
bool qdd_wifi_tcp_live(void);
uint32_t qdd_wifi_tcp_epoch(void);
int qdd_wifi_read(uint8_t *bytes, size_t size);
bool qdd_wifi_write(const char *bytes, size_t size);
void qdd_wifi_close_client(void);
