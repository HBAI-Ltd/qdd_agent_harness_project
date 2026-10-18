#include "qdd_wifi.h"
#include "qdd_control.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_private/wifi.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "freertos/FreeRTOS.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"
#include "nvs.h"
#include "sdkconfig.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static qdd_wifi_view_t s_view = {.port = CONFIG_QDD_TCP_PORT};
static qdd_wifi_ap_t s_networks[QDD_WIFI_SCAN_LIMIT];
static qdd_wifi_ap_t s_scan_networks[QDD_WIFI_SCAN_LIMIT];
static qdd_wifi_credentials_t s_credentials;
static esp_netif_t *s_netif;
static esp_event_handler_instance_t s_wifi_handler, s_ip_handler;
static bool s_initialized, s_started, s_wifi_registered, s_ip_registered;
static bool s_network_initialized;
static atomic_uint s_address, s_network_epoch;
static atomic_bool s_scan_done, s_disconnected;
static atomic_bool s_expected_disconnect, s_intentional_disconnect;
static uint32_t s_seen_network_epoch, s_tcp_epoch;
static uint64_t s_retry_at, s_attempt_at;
static unsigned s_attempts;
static bool s_reconnect = true, s_scan_requested, s_profile_ready;
static bool s_profile_pending, s_joining, s_connected_once;
static unsigned s_config_attempts;
static atomic_bool s_accept_ip;
#define INITIAL_CONNECT_ATTEMPTS 4u
#define CONNECT_TIMEOUT_MS 12000u
static uint64_t s_scan_deadline;
static int s_listener = -1, s_client = -1;
static uint64_t s_client_activity_ms;

// Diagnostic callbacks only count numeric facts; no logs, packet reads or allocation.
static atomic_uint s_diag_connects, s_diag_disconnects, s_diag_beacons;
static atomic_uint s_diag_reason, s_diag_disconnect_ms, s_diag_beacon_ms;
static atomic_uint s_diag_alloc_failures, s_diag_alloc_size, s_diag_alloc_caps;
static atomic_uint s_diag_tx_ok, s_diag_tx_fail, s_diag_tx_ms;
static atomic_int s_diag_tx_hook_error = ESP_ERR_INVALID_STATE;
static atomic_int s_diag_heap_hook_error = ESP_ERR_INVALID_STATE;
static bool s_diag_heap_hook_installed;
static atomic_flag s_diag_busy = ATOMIC_FLAG_INIT;
static wifi_ap_record_t s_diag_ap;
// The control worker owns these cumulative socket facts. They never retain
// command bytes, queue acknowledgements or change the transport's fail-close rules.
static struct {
    uint32_t rx_bytes, tx_bytes, tx_ok, tx_fail, rx_ms, tx_ms;
    int last_errno;
    unsigned close_reason;
} s_diag_tcp;
enum {
    TCP_CLOSE_EXTERNAL = 1, TCP_CLOSE_NETWORK, TCP_CLOSE_EOF,
    TCP_CLOSE_RECV, TCP_CLOSE_SEND
};

static uint32_t diagnostic_now(void) {
    return (uint32_t)((uint64_t)esp_timer_get_time() / 1000u);
}

static int diagnostic_age(uint32_t now, uint32_t then, bool seen) {
    const uint32_t age = now - then;
    return seen && age <= INT_MAX ? (int)age : -1;
}

static void diagnostic_alloc_failed(size_t size, uint32_t caps, const char *function_name) {
    (void)function_name;
#if SIZE_MAX > UINT32_MAX
    if (size > UINT32_MAX) size = UINT32_MAX;
#endif
    atomic_store(&s_diag_alloc_size, (uint32_t)size);
    atomic_store(&s_diag_alloc_caps, caps);
    atomic_fetch_add(&s_diag_alloc_failures, 1);
}

static void diagnostic_tx_done(uint8_t interface, uint8_t *data, uint16_t *length, bool success) {
    (void)data;
    (void)length;
    if (interface != WIFI_IF_STA) return;
    atomic_store(&s_diag_tx_ms, diagnostic_now());
    atomic_fetch_add(success ? &s_diag_tx_ok : &s_diag_tx_fail, 1);
}

size_t qdd_wifi_diagnostics(char *out, size_t capacity) {
    if (!out || !capacity) return 0;
    out[0] = 0;
    if (atomic_flag_test_and_set(&s_diag_busy)) return 0;
    const uint32_t now = diagnostic_now();
    // An unconfigured board has never started the Wi-Fi task. In IDF 5.5.3,
    // sta_get_rssi's unlock path dereferences that absent task even on error.
    const bool active = s_initialized && s_started;
    const esp_err_t inactive = s_initialized ? ESP_ERR_WIFI_NOT_STARTED : ESP_ERR_WIFI_NOT_INIT;
    const esp_err_t ap_error = active ? esp_wifi_sta_get_ap_info(&s_diag_ap) : inactive;
    int rssi = -127;
    const esp_err_t rssi_error = active ? esp_wifi_sta_get_rssi(&rssi) : inactive;
    if (rssi_error != ESP_OK) rssi = -127;
    uint8_t channel = 0;
    wifi_second_chan_t secondary;
    const esp_err_t channel_error = active ? esp_wifi_get_channel(&channel, &secondary) : inactive;
    if (channel_error != ESP_OK) channel = 0;
    wifi_ps_type_t power;
    const esp_err_t power_error = active ? esp_wifi_get_ps(&power) : inactive;
    const bool up = s_netif && esp_netif_is_netif_up(s_netif);
    esp_netif_ip_info_t ip;
    const esp_err_t ip_error = s_netif ? esp_netif_get_ip_info(s_netif, &ip) : ESP_ERR_INVALID_STATE;
    const unsigned disconnects = atomic_load(&s_diag_disconnects);
    const unsigned beacons = atomic_load(&s_diag_beacons);
    const unsigned tx_ok = atomic_load(&s_diag_tx_ok), tx_fail = atomic_load(&s_diag_tx_fail);
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    const size_t limit = capacity < QDD_WIFI_DIAGNOSTICS_MAX + 1u ? capacity : QDD_WIFI_DIAGNOSTICS_MAX + 1u;
    const int length = snprintf(out, limit,
        "{\"ap\":%d,\"rssi\":[%d,%d],\"ch\":[%d,%u],\"ps\":[%d,%d],\"up\":%u,\"ipErr\":%d,"
        "\"ev\":[%u,%u,%u,%u,%d,%d],\"heap\":[%u,%u,%u],\"oom\":[%u,%u,%u],"
        "\"tx\":[%d,%u,%u,%d],\"memHook\":%d,"
        "\"tcp\":[%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%d,%d,%d,%u]}",
        ap_error, rssi_error, rssi, channel_error, (unsigned)channel,
        power_error, power_error == ESP_OK ? (int)power : -1, (unsigned)up, ip_error,
        atomic_load(&s_diag_connects), disconnects, beacons, atomic_load(&s_diag_reason),
        diagnostic_age(now, atomic_load(&s_diag_disconnect_ms), disconnects != 0),
        diagnostic_age(now, atomic_load(&s_diag_beacon_ms), beacons != 0),
        (unsigned)heap_caps_get_free_size(caps), (unsigned)heap_caps_get_minimum_free_size(caps),
        (unsigned)heap_caps_get_largest_free_block(caps), atomic_load(&s_diag_alloc_failures),
        atomic_load(&s_diag_alloc_size), atomic_load(&s_diag_alloc_caps),
        atomic_load(&s_diag_tx_hook_error), tx_ok, tx_fail,
        diagnostic_age(now, atomic_load(&s_diag_tx_ms), tx_ok != 0 || tx_fail != 0),
        atomic_load(&s_diag_heap_hook_error), s_tcp_epoch,
        s_diag_tcp.rx_bytes, s_diag_tcp.tx_bytes, s_diag_tcp.tx_ok, s_diag_tcp.tx_fail,
        diagnostic_age(now, s_diag_tcp.rx_ms, s_diag_tcp.rx_bytes != 0),
        diagnostic_age(now, s_diag_tcp.tx_ms, s_diag_tcp.tx_ok != 0 || s_diag_tcp.tx_fail != 0),
        s_diag_tcp.last_errno, s_diag_tcp.close_reason);
    atomic_flag_clear(&s_diag_busy);
    if (length <= 0 || (size_t)length >= limit) { out[0] = 0; return 0; }
    return (size_t)length;
}

static void publish_flags(bool connected, bool connecting, bool failed) {
    portENTER_CRITICAL(&s_lock);
    s_view.connected = connected;
    s_view.connecting = connecting;
    s_view.failed = failed;
    portEXIT_CRITICAL(&s_lock);
}

qdd_wifi_view_t qdd_wifi_view(void) {
    portENTER_CRITICAL(&s_lock);
    const qdd_wifi_view_t view = s_view;
    portEXIT_CRITICAL(&s_lock);
    return view;
}

bool qdd_wifi_ap(uint8_t index, uint32_t scan_revision, qdd_wifi_ap_t *ap) {
    if (!ap) return false;
    portENTER_CRITICAL(&s_lock);
    const bool current = scan_revision == s_view.scan_revision && index < s_view.count;
    if (current) *ap = s_networks[index];
    portEXIT_CRITICAL(&s_lock);
    return current;
}

static void close_client(unsigned reason) {
    if (s_client >= 0) {
        s_diag_tcp.close_reason = reason;
        close(s_client);
        s_client = -1;
        s_client_activity_ms = 0;
        s_tcp_epoch++;
    }
}

void qdd_wifi_close_client(void) { close_client(TCP_CLOSE_EXTERNAL); }

static void close_listener(void) {
    close_client(TCP_CLOSE_NETWORK);
    if (s_listener >= 0) { close(s_listener); s_listener = -1; }
}

static void event(void *context, esp_event_base_t base, int32_t id, void *data) {
    (void)context;
    // Event task only records bounded numeric facts; never sockets/NVS/UI/HID/credentials.
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        atomic_fetch_add(&s_diag_connects, 1);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_BEACON_TIMEOUT) {
        atomic_store(&s_diag_beacon_ms, diagnostic_now());
        atomic_fetch_add(&s_diag_beacons, 1);
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *disconnected = data;
        atomic_store(&s_diag_reason, disconnected ? disconnected->reason : 0);
        atomic_store(&s_diag_disconnect_ms, diagnostic_now());
        atomic_fetch_add(&s_diag_disconnects, 1);
        const bool requested = atomic_exchange(&s_expected_disconnect, false);
        atomic_store(&s_intentional_disconnect, requested && disconnected &&
            disconnected->reason == WIFI_REASON_ASSOC_LEAVE);
        atomic_store(&s_address, 0);
        atomic_store(&s_disconnected, true);
        atomic_fetch_add(&s_network_epoch, 1);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        atomic_store(&s_scan_done, true);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *got = data;
        if (!got || got->esp_netif != s_netif || !atomic_load(&s_accept_ip)) return;
        atomic_store(&s_expected_disconnect, false);
        atomic_store(&s_address, got->ip_info.ip.addr);
        atomic_fetch_add(&s_network_epoch, 1);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
        atomic_store(&s_address, 0);
        atomic_fetch_add(&s_network_epoch, 1);
    }
}

static void stop_stack(void) {
    s_profile_ready = false;
    s_profile_pending = s_joining = s_connected_once = false;
    atomic_store(&s_accept_ip, false);
    close_listener();
    atomic_store(&s_address, 0);
    if (s_started) { (void)esp_wifi_stop(); s_started = false; }
    if (s_wifi_registered) {
        (void)esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_wifi_handler);
        s_wifi_registered = false;
    }
    if (s_ip_registered) {
        (void)esp_event_handler_instance_unregister(IP_EVENT, ESP_EVENT_ANY_ID, s_ip_handler);
        s_ip_registered = false;
    }
    if (s_initialized) { (void)esp_wifi_deinit(); s_initialized = false; }
    if (s_netif) { esp_netif_destroy_default_wifi(s_netif); s_netif = NULL; }
    atomic_store(&s_scan_done, false);
    atomic_store(&s_disconnected, false);
    atomic_store(&s_expected_disconnect, false);
    atomic_store(&s_intentional_disconnect, false);
    s_scan_requested = false;
    portENTER_CRITICAL(&s_lock);
    s_view.scanning = false;
    s_view.ip[0] = 0;
    portEXIT_CRITICAL(&s_lock);
    publish_flags(false, false, false);
}

static esp_err_t start_stack(void) {
    if (s_started) return ESP_OK;
    if (!s_diag_heap_hook_installed) {
        const esp_err_t hook_error = heap_caps_register_failed_alloc_callback(diagnostic_alloc_failed);
        atomic_store(&s_diag_heap_hook_error, hook_error);
        s_diag_heap_hook_installed = hook_error == ESP_OK;
    }
    esp_err_t error;
    if (!s_network_initialized) {
        error = esp_netif_init();
        if (error != ESP_OK) return error;
        error = esp_event_loop_create_default();
        if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) return error;
        s_network_initialized = true;
    }
    esp_netif_config_t netif = ESP_NETIF_DEFAULT_WIFI_STA();
    s_netif = esp_netif_new(&netif);
    if (!s_netif) return ESP_ERR_NO_MEM;
    error = esp_netif_attach_wifi_station(s_netif);
    if (error != ESP_OK) goto fail;
    error = esp_wifi_set_default_wifi_sta_handlers();
    if (error != ESP_OK) goto fail;
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    error = esp_wifi_init(&config);
    if (error != ESP_OK) goto fail;
    s_initialized = true;
    error = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, event, NULL, &s_wifi_handler);
    if (error != ESP_OK) goto fail;
    s_wifi_registered = true;
    error = esp_event_handler_instance_register(IP_EVENT, ESP_EVENT_ANY_ID, event, NULL, &s_ip_handler);
    if (error != ESP_OK) goto fail;
    s_ip_registered = true;
    error = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (error != ESP_OK) goto fail;
    error = esp_wifi_set_mode(WIFI_MODE_STA);
    if (error != ESP_OK) goto fail;
    // This controller is configured for China: include 2.4 GHz channels 12/13
    // rather than the world-default scan restricted to channels 1..11.
    error = esp_wifi_set_country_code("CN", false);
    if (error != ESP_OK) goto fail;
    error = esp_wifi_start();
    if (error != ESP_OK) goto fail;
    s_started = true;
    atomic_store(&s_diag_tx_hook_error, esp_wifi_set_tx_done_cb(diagnostic_tx_done));
    // USB control and onboarding HTTP also need low-latency Wi-Fi without a TCP HID peer.
    (void)esp_wifi_set_ps(WIFI_PS_NONE);
    return ESP_OK;
fail:
    stop_stack();
    publish_flags(false, false, true);
    return error;
}

static esp_err_t configure_profile(void) {
    wifi_config_t config = {0};
    memcpy(config.sta.ssid, s_credentials.ssid, strlen(s_credentials.ssid));
    memcpy(config.sta.password, s_credentials.password, strlen(s_credentials.password));
    config.sta.threshold.authmode = s_credentials.password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    config.sta.pmf_cfg.capable = true;
    config.sta.pmf_cfg.required = false;
    // Discover every BSSID for this SSID, rather than binding to a stale mesh
    // radio or accepting the first weaker AP returned by a fast scan.
    config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    config.sta.bssid_set = false;
    const esp_err_t error = esp_wifi_set_config(WIFI_IF_STA, &config);
    memset(&config, 0, sizeof(config));
    return error;
}

static esp_err_t apply_credentials(void) {
    s_profile_ready = false;
    s_profile_pending = s_joining = s_connected_once = false;
    atomic_store(&s_accept_ip, false);
    atomic_store(&s_address, 0);
    atomic_fetch_add(&s_network_epoch, 1);
    atomic_store(&s_disconnected, false);
    atomic_store(&s_intentional_disconnect, false);
    close_listener();
    esp_err_t error = start_stack();
    if (error != ESP_OK) return error;
    atomic_store(&s_expected_disconnect, true);
    if (esp_wifi_disconnect() != ESP_OK) atomic_store(&s_expected_disconnect, false);
    error = configure_profile();
    s_config_attempts = 1;
    if (error != ESP_OK && error != ESP_ERR_WIFI_STATE) {
        atomic_store(&s_expected_disconnect, false);
        atomic_store(&s_intentional_disconnect, false);
        s_reconnect = false;
        publish_flags(false, false, true);
        return error;
    }
    // Disconnect is asynchronous. WIFI_STATE during configuration is a short
    // worker retry, never a reason to discard credentials or use the old AP.
    s_profile_pending = error == ESP_ERR_WIFI_STATE;
    s_profile_ready = !s_profile_pending;
    s_attempts = 0;
    s_retry_at = 0;
    s_reconnect = true;
    publish_flags(false, true, false);
    return ESP_OK;
}

static void schedule_retry(uint64_t now_ms) {
    s_joining = false;
    const bool exhausted = !s_connected_once && s_attempts >= INITIAL_CONNECT_ATTEMPTS;
    const unsigned shift = s_attempts > 0 ? (s_attempts - 1 < 6 ? s_attempts - 1 : 6) : 0;
    const uint64_t delay = 500u << shift;
    s_retry_at = now_ms + (delay < 30000u ? delay : 30000u);
    publish_flags(false, !exhausted, exhausted);
}

esp_err_t qdd_wifi_start(void) {
    // qdd_ble_start already initializes NVS without an erase fallback.
    nvs_handle_t handle;
    esp_err_t error = nvs_open("qdd_wifi", NVS_READONLY, &handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (error != ESP_OK) return error;
    size_t size = sizeof(s_credentials);
    error = nvs_get_blob(handle, "profile", &s_credentials, &size);
    nvs_close(handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (error != ESP_OK || size != sizeof(s_credentials) || !qdd_wifi_credentials_valid(&s_credentials)) {
        memset(&s_credentials, 0, sizeof(s_credentials));
        publish_flags(false, false, true);
        return ESP_ERR_INVALID_STATE;
    }
    portENTER_CRITICAL(&s_lock);
    s_view.configured = true;
    portEXIT_CRITICAL(&s_lock);
    return apply_credentials();
}

esp_err_t qdd_wifi_save(const qdd_wifi_credentials_t *credentials) {
    if (!qdd_wifi_credentials_valid(credentials)) return ESP_ERR_INVALID_ARG;
    nvs_handle_t handle;
    esp_err_t error = nvs_open("qdd_wifi", NVS_READWRITE, &handle);
    if (error != ESP_OK) return error;
    // One atomic blob avoids mixing an old password with a newly saved SSID.
    error = nvs_set_blob(handle, "profile", credentials, sizeof(*credentials));
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    if (error != ESP_OK) return error;
    s_credentials = *credentials;
    portENTER_CRITICAL(&s_lock);
    s_view.configured = true;
    portEXIT_CRITICAL(&s_lock);
    return apply_credentials();
}

esp_err_t qdd_wifi_clear(void) {
    nvs_handle_t handle;
    esp_err_t error = nvs_open("qdd_wifi", NVS_READWRITE, &handle);
    if (error != ESP_OK) return error;
    error = nvs_erase_key(handle, "profile");
    if (error == ESP_ERR_NVS_NOT_FOUND) error = ESP_OK;
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    if (error != ESP_OK) return error;
    stop_stack();
    memset(&s_credentials, 0, sizeof(s_credentials));
    portENTER_CRITICAL(&s_lock);
    s_view.configured = false;
    s_view.count = 0;
    s_view.scan_revision++;
    portEXIT_CRITICAL(&s_lock);
    return ESP_OK;
}

esp_err_t qdd_wifi_retry(void) {
    if (!qdd_wifi_view().configured) return ESP_ERR_INVALID_STATE;
    return apply_credentials();
}

esp_err_t qdd_wifi_scan(void) {
    esp_err_t error = start_stack();
    if (error != ESP_OK) return error;
    if (qdd_wifi_view().scanning) return ESP_OK;
    s_reconnect = false;
    if (qdd_wifi_view().connecting) (void)esp_wifi_disconnect();
    s_scan_requested = true;
    s_scan_deadline = 0;
    atomic_store(&s_scan_done, false);
    portENTER_CRITICAL(&s_lock);
    s_view.scanning = true;
    s_view.failed = false;
    portEXIT_CRITICAL(&s_lock);
    return ESP_OK;
}

void qdd_wifi_allow_reconnect(bool enabled) { s_reconnect = enabled; }

static void retain_network(const wifi_ap_record_t *record, uint8_t *count) {
    const size_t length = strnlen((const char *)record->ssid, sizeof(record->ssid));
    if (!length || length > 32) return;
    qdd_wifi_ap_t ap = {.rssi = record->rssi, .open = record->authmode == WIFI_AUTH_OPEN};
    memcpy(ap.ssid, record->ssid, length);
    memcpy(ap.bssid, record->bssid, sizeof(ap.bssid));
    // Mesh APs and repeaters with the same SSID/security are one selectable
    // network. Traverse every SDK record before deciding the strongest 64.
    for (unsigned i = 0; i < *count; i++) {
        if (strcmp(ap.ssid, s_scan_networks[i].ssid) != 0 || ap.open != s_scan_networks[i].open) continue;
        if (ap.rssi <= s_scan_networks[i].rssi) return;
        memmove(&s_scan_networks[i], &s_scan_networks[i + 1],
            ((size_t)*count - i - 1) * sizeof(ap));
        --*count;
        break;
    }
    if (*count == QDD_WIFI_SCAN_LIMIT) {
        if (ap.rssi <= s_scan_networks[*count - 1].rssi) return;
        --*count;
    }
    unsigned position = 0;
    while (position < *count && s_scan_networks[position].rssi >= ap.rssi) position++;
    memmove(&s_scan_networks[position + 1], &s_scan_networks[position],
        ((size_t)*count - position) * sizeof(ap));
    s_scan_networks[position] = ap;
    ++*count;
}

static void finish_scan(void) {
    uint16_t found = 0;
    uint8_t count = 0;
    memset(s_scan_networks, 0, sizeof(s_scan_networks));
    esp_err_t error = esp_wifi_scan_get_ap_num(&found);
    for (uint16_t i = 0; error == ESP_OK && i < found; i++) {
        wifi_ap_record_t record;
        // The SDK frees each entry as it is retrieved. Avoid a large temporary
        // AP array while Wi-Fi, BLE and the display share the C3's internal RAM.
        error = esp_wifi_scan_get_ap_record(&record);
        if (error == ESP_OK) retain_network(&record, &count);
    }
    (void)esp_wifi_clear_ap_list();
    portENTER_CRITICAL(&s_lock);
    s_view.count = error == ESP_OK ? count : 0;
    if (error == ESP_OK) memcpy(s_networks, s_scan_networks, sizeof(s_networks));
    s_view.scan_revision++;
    s_view.scanning = false;
    s_view.failed = error != ESP_OK;
    portEXIT_CRITICAL(&s_lock);
}

static void start_listener(uint32_t address) {
    if (!qdd_private_ipv4(ntohl(address))) return;
    const int socket_fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_fd < 0) return;
    const int one = 1;
    (void)setsockopt(socket_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in local = {.sin_family = AF_INET, .sin_port = htons(CONFIG_QDD_TCP_PORT)};
    local.sin_addr.s_addr = address;
    if (fcntl(socket_fd, F_SETFL, O_NONBLOCK) < 0 ||
        bind(socket_fd, (struct sockaddr *)&local, sizeof(local)) < 0 || listen(socket_fd, 1) < 0) {
        close(socket_fd);
        return;
    }
    s_listener = socket_fd;
}

void qdd_wifi_poll(uint64_t now_ms, bool tcp_control_owned) {
    if (!s_started) return;
    const uint32_t epoch = atomic_load(&s_network_epoch);
    uint32_t address = atomic_load(&s_address);
    if (epoch != s_seen_network_epoch) {
        close_listener(); // Even the same address after reconnect invalidates old sockets.
        s_seen_network_epoch = epoch;
        if (address) {
            wifi_ap_record_t associated;
            if (!s_profile_ready || esp_wifi_sta_get_ap_info(&associated) != ESP_OK ||
                strncmp((const char *)associated.ssid, s_credentials.ssid, sizeof(associated.ssid)) != 0) {
                address = 0;
                atomic_store(&s_address, 0);
            }
        }
        portENTER_CRITICAL(&s_lock);
        s_view.ip[0] = 0;
        if (address) (void)inet_ntop(AF_INET, &address, s_view.ip, sizeof(s_view.ip));
        portEXIT_CRITICAL(&s_lock);
        if (address) {
            s_attempts = 0; s_joining = false; s_connected_once = true;
            publish_flags(true, false, false);
        } else publish_flags(false, s_profile_pending || s_joining,
            !s_profile_ready && !s_profile_pending && qdd_wifi_view().configured);
    }
    if (atomic_exchange(&s_scan_done, false)) finish_scan();
    if (atomic_exchange(&s_disconnected, false) && !address) {
        const bool intentional = atomic_exchange(&s_intentional_disconnect, false);
        if (s_profile_ready && s_reconnect) {
            schedule_retry(now_ms);
            if (intentional) s_retry_at = now_ms;
        }
    }
    if (s_scan_requested) {
        if (!s_scan_deadline) s_scan_deadline = now_ms + 5000;
        wifi_scan_config_t config = {0};
        config.channel = 0;
        config.show_hidden = true;
        config.scan_time.active.min = 100;
        config.scan_time.active.max = 300;
        const esp_err_t error = esp_wifi_scan_start(&config, false);
        if (error == ESP_OK) s_scan_requested = false;
        else if (error != ESP_ERR_WIFI_STATE || now_ms >= s_scan_deadline) {
            s_scan_requested = false;
            portENTER_CRITICAL(&s_lock);
            s_view.scanning = false;
            s_view.failed = true;
            portEXIT_CRITICAL(&s_lock);
        }
    }
    if (s_profile_pending && s_reconnect && now_ms >= s_retry_at) {
        const esp_err_t error = configure_profile();
        s_config_attempts++;
        if (error == ESP_OK) { s_profile_pending = false; s_profile_ready = true; s_retry_at = now_ms; }
        else if (error == ESP_ERR_WIFI_STATE && s_config_attempts < INITIAL_CONNECT_ATTEMPTS) {
            s_retry_at = now_ms + 250u;
        } else {
            s_profile_pending = false; s_reconnect = false;
            publish_flags(false, false, true);
        }
    }
    const qdd_wifi_view_t view = qdd_wifi_view();
    if (!address && s_reconnect && s_profile_ready && view.configured && !view.scanning) {
        if (!s_connected_once && s_attempts >= INITIAL_CONNECT_ATTEMPTS && !s_joining) {
            publish_flags(false, false, true);
        } else if (s_joining && now_ms - s_attempt_at >= CONNECT_TIMEOUT_MS) {
            atomic_store(&s_expected_disconnect, true);
            if (esp_wifi_disconnect() != ESP_OK) atomic_store(&s_expected_disconnect, false);
            schedule_retry(now_ms);
        } else if (!s_joining && now_ms >= s_retry_at) {
            s_attempt_at = now_ms;
            if (s_attempts < 6) s_attempts++;
            atomic_store(&s_accept_ip, true);
            const esp_err_t error = esp_wifi_connect();
            s_joining = error == ESP_OK;
            if (s_joining) publish_flags(false, true, false);
            else { atomic_store(&s_accept_ip, false); schedule_retry(now_ms); }
        }
    }
    if (address && s_profile_ready && s_listener < 0) start_listener(address);
    if (s_listener >= 0) {
        struct sockaddr_in peer;
        socklen_t size = sizeof(peer);
        const int accepted = accept(s_listener, (struct sockaddr *)&peer, &size);
        if (accepted >= 0) {
            if (!qdd_private_ipv4(ntohl(peer.sin_addr.s_addr)) ||
                fcntl(accepted, F_SETFL, O_NONBLOCK) < 0) close(accepted);
            else if (s_client >= 0 && (tcp_control_owned || now_ms < s_client_activity_ms ||
                now_ms - s_client_activity_ms <= QDD_HEARTBEAT_MS)) close(accepted);
            else {
                // Only a validated new peer can retire a silent, owner-free observer.
                // Active control keeps its existing fail-close watchdog and cannot be stolen.
                if (s_client >= 0) close_client(TCP_CLOSE_EXTERNAL);
                const int one = 1;
                (void)setsockopt(accepted, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
                s_client = accepted;
                s_client_activity_ms = now_ms;
                s_tcp_epoch++;
                (void)esp_wifi_set_ps(WIFI_PS_NONE);
            }
        }
    }
}

bool qdd_wifi_tcp_live(void) {
    // Fail closed immediately, including a disconnect/reconnect with the same IP
    // between poll() and dispatch. Worker cleanup catches up on the next poll.
    return s_profile_ready && s_client >= 0 && atomic_load(&s_address) != 0 &&
        atomic_load(&s_network_epoch) == s_seen_network_epoch;
}
uint32_t qdd_wifi_tcp_epoch(void) { return s_tcp_epoch; }

int qdd_wifi_read(uint8_t *bytes, size_t size) {
    if (!qdd_wifi_tcp_live()) { close_client(TCP_CLOSE_NETWORK); return 0; }
    const int count = recv(s_client, bytes, size, MSG_DONTWAIT);
    if (count > 0) {
        const uint64_t now_ms = (uint64_t)esp_timer_get_time() / 1000u;
        s_client_activity_ms = now_ms;
        s_diag_tcp.rx_bytes += (uint32_t)count;
        s_diag_tcp.rx_ms = (uint32_t)now_ms;
        return count;
    }
    if (count == 0) close_client(TCP_CLOSE_EOF);
    else if (errno != EAGAIN && errno != EWOULDBLOCK) {
        s_diag_tcp.last_errno = errno;
        close_client(TCP_CLOSE_RECV);
    }
    return 0;
}

bool qdd_wifi_write(const char *bytes, size_t size) {
    if (!qdd_wifi_tcp_live()) { close_client(TCP_CLOSE_NETWORK); return false; }
    const ssize_t sent = send(s_client, bytes, size, MSG_DONTWAIT);
    const int error = sent < 0 ? errno : 0;
    s_diag_tcp.tx_ms = diagnostic_now();
    if (sent > 0) s_diag_tcp.tx_bytes += (uint32_t)sent;
    if (sent == (ssize_t)size) {
        s_diag_tcp.tx_ok++;
        return true;
    }
    s_diag_tcp.tx_fail++;
    s_diag_tcp.last_errno = error;
    // Never queue an input acknowledgement indefinitely or retry a HID command.
    close_client(TCP_CLOSE_SEND);
    return false;
}
