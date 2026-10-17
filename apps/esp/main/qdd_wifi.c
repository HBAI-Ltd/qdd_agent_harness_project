#include "qdd_wifi.h"
#include "qdd_control.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "freertos/FreeRTOS.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"
#include "nvs.h"
#include "sdkconfig.h"
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
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
static uint64_t s_scan_deadline;
static int s_listener = -1, s_client = -1;

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

void qdd_wifi_close_client(void) {
    if (s_client >= 0) {
        close(s_client);
        s_client = -1;
        s_tcp_epoch++;
        if (s_started) (void)esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    }
}

static void close_listener(void) {
    qdd_wifi_close_client();
    if (s_listener >= 0) { close(s_listener); s_listener = -1; }
}

static void event(void *context, esp_event_base_t base, int32_t id, void *data) {
    (void)context;
    // Event task never touches sockets, NVS, UI, HID state or credentials.
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *disconnected = data;
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
    (void)esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    return ESP_OK;
fail:
    stop_stack();
    publish_flags(false, false, true);
    return error;
}

static esp_err_t apply_credentials(void) {
    s_profile_ready = false;
    close_listener();
    esp_err_t error = start_stack();
    if (error != ESP_OK) return error;
    atomic_store(&s_expected_disconnect, true);
    if (esp_wifi_disconnect() != ESP_OK) atomic_store(&s_expected_disconnect, false);
    wifi_config_t config = {0};
    memcpy(config.sta.ssid, s_credentials.ssid, strlen(s_credentials.ssid));
    memcpy(config.sta.password, s_credentials.password, strlen(s_credentials.password));
    config.sta.threshold.authmode = s_credentials.password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    config.sta.pmf_cfg.capable = true;
    config.sta.pmf_cfg.required = false;
    error = esp_wifi_set_config(WIFI_IF_STA, &config);
    memset(&config, 0, sizeof(config));
    if (error != ESP_OK) {
        atomic_store(&s_expected_disconnect, false);
        atomic_store(&s_intentional_disconnect, false);
        s_reconnect = false;
        publish_flags(false, false, true);
        return error;
    }
    s_profile_ready = true;
    s_attempts = 0;
    s_retry_at = 0;
    s_reconnect = true;
    publish_flags(false, false, false);
    return ESP_OK;
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

void qdd_wifi_poll(uint64_t now_ms) {
    if (!s_started) return;
    const uint32_t epoch = atomic_load(&s_network_epoch), address = atomic_load(&s_address);
    if (epoch != s_seen_network_epoch) {
        close_listener(); // Even the same address after reconnect invalidates old sockets.
        s_seen_network_epoch = epoch;
        portENTER_CRITICAL(&s_lock);
        s_view.ip[0] = 0;
        if (address) (void)inet_ntop(AF_INET, &address, s_view.ip, sizeof(s_view.ip));
        portEXIT_CRITICAL(&s_lock);
        publish_flags(address != 0 && s_profile_ready, false, !s_profile_ready && qdd_wifi_view().configured);
        if (address) s_attempts = 0;
    }
    if (atomic_exchange(&s_scan_done, false)) finish_scan();
    if (atomic_exchange(&s_disconnected, false) && !address) {
        const bool intentional = atomic_exchange(&s_intentional_disconnect, false);
        s_retry_at = intentional ? now_ms : now_ms + (s_attempts < 5 ? 1000u << s_attempts : 30000u);
        publish_flags(false, false, !intentional);
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
    const qdd_wifi_view_t view = qdd_wifi_view();
    if (!address && s_reconnect && s_profile_ready && view.configured && !view.scanning) {
        if (view.connecting && now_ms - s_attempt_at > 15000) {
            (void)esp_wifi_disconnect();
            s_retry_at = now_ms + 30000;
            publish_flags(false, false, true);
        } else if (!view.connecting && now_ms >= s_retry_at) {
            const esp_err_t error = esp_wifi_connect();
            s_attempt_at = now_ms;
            if (s_attempts < 6) s_attempts++;
            s_retry_at = now_ms + 30000;
            publish_flags(false, error == ESP_OK, error != ESP_OK);
        }
    }
    if (address && s_profile_ready && s_listener < 0) start_listener(address);
    if (s_listener >= 0) {
        struct sockaddr_in peer;
        socklen_t size = sizeof(peer);
        const int accepted = accept(s_listener, (struct sockaddr *)&peer, &size);
        if (accepted >= 0) {
            if (s_client >= 0 || !qdd_private_ipv4(ntohl(peer.sin_addr.s_addr)) ||
                fcntl(accepted, F_SETFL, O_NONBLOCK) < 0) close(accepted);
            else {
                const int one = 1;
                (void)setsockopt(accepted, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
                s_client = accepted;
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
    if (!qdd_wifi_tcp_live()) { qdd_wifi_close_client(); return 0; }
    const int count = recv(s_client, bytes, size, MSG_DONTWAIT);
    if (count > 0) return count;
    if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) qdd_wifi_close_client();
    return 0;
}

bool qdd_wifi_write(const char *bytes, size_t size) {
    if (qdd_wifi_tcp_live() && send(s_client, bytes, size, MSG_DONTWAIT) == (ssize_t)size) return true;
    // Never queue an input acknowledgement indefinitely or retry a HID command.
    qdd_wifi_close_client();
    return false;
}
