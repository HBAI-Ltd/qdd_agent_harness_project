#define _POSIX_C_SOURCE 200809L

#include <assert.h>
#include <stdio.h>

// Compile the production backend itself. SDK/socket stubs provide deterministic
// faults; no real network, NVS, device, HID or LVGL API is linked by this test.
#include "../main/qdd_wifi.c"

const char qdd_test_wifi_event[] = "wifi";
const char qdd_test_ip_event[] = "ip";

enum sdk_step {
    SDK_NETIF_INIT, SDK_EVENT_LOOP, SDK_NETIF_NEW, SDK_ATTACH, SDK_DEFAULT_HANDLERS,
    SDK_WIFI_INIT, SDK_REGISTER_WIFI, SDK_REGISTER_IP, SDK_STORAGE, SDK_COUNTRY, SDK_MODE,
    SDK_START, SDK_STOP, SDK_DEINIT, SDK_UNREGISTER, SDK_DESTROY, SDK_POWER,
    SDK_DISCONNECT, SDK_CONFIG, SDK_CONNECT, SDK_SCAN, SDK_SCAN_COUNT, SDK_SCAN_RECORDS, SDK_SCAN_CLEAR,
    SDK_STEP_COUNT
};

typedef struct {
    unsigned sdk_calls[SDK_STEP_COUNT], critical_calls, critical_depth;
    int failure_step;
    esp_err_t loop_result, scan_result, config_result, connect_result, records_result;
    unsigned socket_calls, accept_calls, send_calls, recv_calls, bind_calls, listen_calls;
    unsigned close_calls[128], option_calls, nonblock_calls;
    int next_socket, next_accepted, fail_nonblock_fd;
    bool socket_failure, bind_failure, listen_failure;
    uint32_t peer_address, bound_address;
    ssize_t recv_result, send_result;
    int recv_error, send_error, last_power;
    wifi_config_t station_config;
    wifi_ap_record_t associated_ap;
    int storage;
    wifi_ap_record_t records[256];
    uint16_t record_count, record_index;
    unsigned records_freed;
    unsigned nvs_open_calls, nvs_get_calls, nvs_set_calls, nvs_commit_calls;
    unsigned nvs_close_calls, nvs_erase_calls;
    esp_err_t open_result, get_result, set_result, commit_result, erase_result;
    bool profile_present, pending_set, pending_erase;
    size_t profile_size;
    qdd_wifi_credentials_t profile, pending_profile;
    uint32_t bond_marker;
    int64_t now_us;
    esp_err_t ap_result, rssi_result, channel_result, ps_result, ip_result;
    esp_err_t tx_hook_result, heap_hook_result;
    unsigned tx_hook_calls, heap_hook_calls;
    unsigned diagnostic_getters[4];
    int actual_rssi;
    uint8_t actual_channel;
    bool netif_up;
    size_t heap_free, heap_minimum, heap_largest;
    wifi_tx_done_cb_t tx_callback;
    esp_alloc_failed_hook_t heap_callback;
} mock_t;

static mock_t m;
static esp_netif_t mock_netif;

static esp_err_t sdk_result(enum sdk_step step) {
    m.sdk_calls[step]++;
    return m.failure_step == (int)step ? ESP_FAIL : ESP_OK;
}

void qdd_test_enter_critical(portMUX_TYPE *lock) {
    assert(lock == &s_lock);
    m.critical_calls++;
    m.critical_depth++;
}

void qdd_test_exit_critical(portMUX_TYPE *lock) {
    assert(lock == &s_lock && m.critical_depth > 0);
    m.critical_depth--;
}

esp_err_t esp_netif_init(void) { return sdk_result(SDK_NETIF_INIT); }
esp_err_t esp_event_loop_create_default(void) {
    const esp_err_t error = sdk_result(SDK_EVENT_LOOP);
    return error == ESP_OK ? m.loop_result : error;
}
esp_netif_t *esp_netif_new(const esp_netif_config_t *config) {
    assert(config != NULL);
    return sdk_result(SDK_NETIF_NEW) == ESP_OK ? &mock_netif : NULL;
}
esp_err_t esp_netif_attach_wifi_station(esp_netif_t *netif) {
    assert(netif == &mock_netif);
    return sdk_result(SDK_ATTACH);
}
esp_err_t esp_wifi_set_default_wifi_sta_handlers(void) { return sdk_result(SDK_DEFAULT_HANDLERS); }
esp_err_t esp_wifi_init(const wifi_init_config_t *config) {
    assert(config != NULL);
    return sdk_result(SDK_WIFI_INIT);
}
esp_err_t esp_event_handler_instance_register(esp_event_base_t base, int32_t id,
    esp_event_handler_t handler, void *context, esp_event_handler_instance_t *instance) {
    assert(id == ESP_EVENT_ANY_ID && handler == event && context == NULL);
    assert(base == WIFI_EVENT || base == IP_EVENT);
    *instance = base == WIFI_EVENT ? (void *)&s_wifi_handler : (void *)&s_ip_handler;
    return sdk_result(base == WIFI_EVENT ? SDK_REGISTER_WIFI : SDK_REGISTER_IP);
}
esp_err_t esp_event_handler_instance_unregister(esp_event_base_t base, int32_t id,
    esp_event_handler_instance_t instance) {
    assert(id == ESP_EVENT_ANY_ID);
    assert(instance == (base == WIFI_EVENT ? (void *)&s_wifi_handler : (void *)&s_ip_handler));
    return sdk_result(SDK_UNREGISTER);
}
esp_err_t esp_wifi_set_storage(int storage) { m.storage = storage; return sdk_result(SDK_STORAGE); }
esp_err_t esp_wifi_set_country_code(const char *country, bool ieee80211d_enabled) {
    assert(country != NULL && strcmp(country, "CN") == 0 && !ieee80211d_enabled);
    return sdk_result(SDK_COUNTRY);
}
esp_err_t esp_wifi_set_mode(int mode) { assert(mode == WIFI_MODE_STA); return sdk_result(SDK_MODE); }
esp_err_t esp_wifi_start(void) { return sdk_result(SDK_START); }
esp_err_t esp_wifi_stop(void) { return sdk_result(SDK_STOP); }
esp_err_t esp_wifi_deinit(void) { return sdk_result(SDK_DEINIT); }
void esp_netif_destroy_default_wifi(esp_netif_t *netif) {
    assert(netif == &mock_netif);
    (void)sdk_result(SDK_DESTROY);
}
esp_err_t esp_wifi_set_ps(int mode) { m.last_power = mode; return sdk_result(SDK_POWER); }
esp_err_t esp_wifi_disconnect(void) { return sdk_result(SDK_DISCONNECT); }
esp_err_t esp_wifi_set_config(int interface, const wifi_config_t *config) {
    assert(interface == WIFI_IF_STA);
    m.station_config = *config;
    (void)sdk_result(SDK_CONFIG);
    return m.config_result;
}
esp_err_t esp_wifi_connect(void) { (void)sdk_result(SDK_CONNECT); return m.connect_result; }
esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *record) { m.diagnostic_getters[0]++; *record = m.associated_ap; return m.ap_result; }
int64_t esp_timer_get_time(void) { return m.now_us; }
esp_err_t esp_wifi_sta_get_rssi(int *rssi) { m.diagnostic_getters[1]++; *rssi = m.actual_rssi; return m.rssi_result; }
esp_err_t esp_wifi_get_channel(uint8_t *primary, wifi_second_chan_t *secondary) {
    m.diagnostic_getters[2]++;
    *primary = m.actual_channel; *secondary = 0; return m.channel_result;
}
esp_err_t esp_wifi_get_ps(wifi_ps_type_t *mode) { m.diagnostic_getters[3]++; *mode = m.last_power; return m.ps_result; }
bool esp_netif_is_netif_up(esp_netif_t *netif) { assert(netif == &mock_netif); return m.netif_up; }
esp_err_t esp_netif_get_ip_info(esp_netif_t *netif, esp_netif_ip_info_t *info) {
    assert(netif == &mock_netif); info->ip.addr = m.peer_address; return m.ip_result;
}
esp_err_t esp_wifi_set_tx_done_cb(wifi_tx_done_cb_t callback) {
    m.tx_hook_calls++; m.tx_callback = callback; return m.tx_hook_result;
}
esp_err_t heap_caps_register_failed_alloc_callback(esp_alloc_failed_hook_t callback) {
    m.heap_hook_calls++; m.heap_callback = callback; return m.heap_hook_result;
}
size_t heap_caps_get_free_size(uint32_t caps) {
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)); return m.heap_free;
}
size_t heap_caps_get_minimum_free_size(uint32_t caps) {
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)); return m.heap_minimum;
}
size_t heap_caps_get_largest_free_block(uint32_t caps) {
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)); return m.heap_largest;
}
esp_err_t esp_wifi_scan_start(const wifi_scan_config_t *config, bool block) {
    assert(!block && config->channel == 0 && config->ssid == NULL && config->bssid == NULL);
    assert(config->show_hidden);
    assert(config->scan_time.active.min == 100 && config->scan_time.active.max == 300);
    (void)sdk_result(SDK_SCAN);
    if (m.scan_result == ESP_OK) m.record_index = 0;
    return m.scan_result;
}
esp_err_t esp_wifi_scan_get_ap_num(uint16_t *count) {
    assert(count != NULL);
    const esp_err_t error = sdk_result(SDK_SCAN_COUNT);
    if (error != ESP_OK) return error;
    *count = m.record_count;
    return ESP_OK;
}
esp_err_t esp_wifi_scan_get_ap_record(wifi_ap_record_t *record) {
    assert(record != NULL);
    const esp_err_t error = sdk_result(SDK_SCAN_RECORDS);
    if (error != ESP_OK) return error;
    if (m.records_result != ESP_OK) return m.records_result;
    if (m.record_index >= m.record_count) return ESP_FAIL;
    *record = m.records[m.record_index++];
    m.records_freed++;
    return ESP_OK;
}
esp_err_t esp_wifi_clear_ap_list(void) {
    m.records_freed += m.record_count - m.record_index;
    m.record_index = m.record_count;
    return sdk_result(SDK_SCAN_CLEAR);
}

uint32_t qdd_test_ntohl(uint32_t value) {
    const uint32_t native_one = 1;
    if (*(const uint8_t *)&native_one != 1) return value;
    return ((value & 0xffu) << 24u) | ((value & 0xff00u) << 8u) |
           ((value & 0xff0000u) >> 8u) | ((value & 0xff000000u) >> 24u);
}
uint16_t qdd_test_htons(uint16_t value) {
    const uint32_t native_one = 1;
    return *(const uint8_t *)&native_one == 1 ? (uint16_t)((value << 8u) | (value >> 8u)) : value;
}
const char *qdd_test_inet_ntop(int family, const void *source, char *dest, socklen_t size) {
    assert(family == AF_INET && size >= 16);
    const uint32_t host = qdd_test_ntohl(*(const uint32_t *)source);
    (void)snprintf(dest, size, "%u.%u.%u.%u", host >> 24u, (host >> 16u) & 255u,
                   (host >> 8u) & 255u, host & 255u);
    return dest;
}
int qdd_test_socket(int domain, int type, int protocol) {
    assert(domain == AF_INET && type == SOCK_STREAM && protocol == IPPROTO_TCP);
    m.socket_calls++;
    return m.socket_failure ? -1 : m.next_socket++;
}
int qdd_test_close(int descriptor) {
    assert(descriptor >= 0 && descriptor < 128);
    m.close_calls[descriptor]++;
    assert(m.close_calls[descriptor] == 1); // Every descriptor is closed once.
    return 0;
}
int qdd_test_setsockopt(int descriptor, int level, int option, const void *value, socklen_t size) {
    assert(descriptor >= 0 && size == sizeof(int) && *(const int *)value == 1);
    assert((level == SOL_SOCKET && option == SO_REUSEADDR) ||
           (level == IPPROTO_TCP && option == TCP_NODELAY));
    m.option_calls++;
    return 0;
}
int qdd_test_fcntl(int descriptor, int command, int flags) {
    assert(command == F_SETFL && flags == O_NONBLOCK);
    m.nonblock_calls++;
    return descriptor == m.fail_nonblock_fd ? -1 : 0;
}
int qdd_test_bind(int descriptor, const struct sockaddr *address, socklen_t size) {
    assert(descriptor >= 0 && size == sizeof(struct sockaddr_in));
    const struct sockaddr_in *local = (const struct sockaddr_in *)address;
    assert(local->sin_family == AF_INET && local->sin_port == htons(CONFIG_QDD_TCP_PORT));
    m.bound_address = local->sin_addr.s_addr;
    m.bind_calls++;
    return m.bind_failure ? -1 : 0;
}
int qdd_test_listen(int descriptor, int backlog) {
    assert(descriptor >= 0 && backlog == 1);
    m.listen_calls++;
    return m.listen_failure ? -1 : 0;
}
int qdd_test_accept(int descriptor, struct sockaddr *address, socklen_t *size) {
    assert(descriptor == s_listener && *size == sizeof(struct sockaddr_in));
    m.accept_calls++;
    const int accepted = m.next_accepted;
    m.next_accepted = -1;
    if (accepted >= 0) {
        struct sockaddr_in *peer = (struct sockaddr_in *)address;
        memset(peer, 0, sizeof(*peer));
        peer->sin_family = AF_INET;
        peer->sin_addr.s_addr = m.peer_address;
    }
    return accepted;
}
ssize_t qdd_test_recv(int descriptor, void *bytes, size_t size, int flags) {
    assert(descriptor == s_client && flags == MSG_DONTWAIT);
    m.recv_calls++;
    errno = m.recv_error;
    if (m.recv_result > 0) {
        assert((size_t)m.recv_result <= size);
        memset(bytes, 'R', (size_t)m.recv_result);
    }
    return m.recv_result;
}
ssize_t qdd_test_send(int descriptor, const void *bytes, size_t size, int flags) {
    assert(descriptor == s_client && bytes != NULL && flags == MSG_DONTWAIT);
    m.send_calls++;
    errno = m.send_error;
    return m.send_result == -2 ? (ssize_t)size : m.send_result;
}

esp_err_t nvs_open(const char *namespace_name, int mode, nvs_handle_t *handle) {
    assert(strcmp(namespace_name, "qdd_wifi") == 0);
    assert(mode == NVS_READONLY || mode == NVS_READWRITE);
    m.nvs_open_calls++;
    m.pending_set = m.pending_erase = false;
    *handle = 42;
    return m.open_result;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *value, size_t *size) {
    assert(handle == 42 && strcmp(key, "profile") == 0);
    m.nvs_get_calls++;
    if (m.get_result != ESP_OK) return m.get_result;
    if (!m.profile_present) return ESP_ERR_NVS_NOT_FOUND;
    const size_t copied = *size < m.profile_size ? *size : m.profile_size;
    memcpy(value, &m.profile, copied);
    *size = m.profile_size;
    return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t size) {
    assert(handle == 42 && strcmp(key, "profile") == 0 && size == sizeof(qdd_wifi_credentials_t));
    m.nvs_set_calls++;
    if (m.set_result == ESP_OK) {
        m.pending_profile = *(const qdd_wifi_credentials_t *)value;
        m.pending_set = true;
    }
    return m.set_result;
}
esp_err_t nvs_commit(nvs_handle_t handle) {
    assert(handle == 42);
    m.nvs_commit_calls++;
    if (m.commit_result != ESP_OK) return m.commit_result;
    if (m.pending_set) {
        m.profile = m.pending_profile;
        m.profile_present = true;
        m.profile_size = sizeof(m.profile);
    }
    if (m.pending_erase) m.profile_present = false;
    return ESP_OK;
}
void nvs_close(nvs_handle_t handle) {
    assert(handle == 42);
    m.nvs_close_calls++;
    m.pending_set = m.pending_erase = false;
}
esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key) {
    assert(handle == 42 && strcmp(key, "profile") == 0);
    m.nvs_erase_calls++;
    if (m.erase_result == ESP_OK) m.pending_erase = true;
    return m.erase_result;
}

static uint32_t address(uint32_t host) { return qdd_test_ntohl(host); }

static void reset(void) {
    memset(&m, 0, sizeof(m));
    m.failure_step = -1;
    m.fail_nonblock_fd = -1;
    m.next_socket = 20;
    m.next_accepted = -1;
    m.peer_address = address(0xc0a80102u);
    m.recv_result = -1;
    m.recv_error = EAGAIN;
    m.send_result = -2;
    m.bond_marker = 0xa1b2c3d4u;
    s_lock = 0;
    s_view = (qdd_wifi_view_t){.port = CONFIG_QDD_TCP_PORT};
    memset(&s_credentials, 0, sizeof(s_credentials));
    s_netif = NULL;
    s_wifi_handler = s_ip_handler = NULL;
    s_initialized = s_started = s_wifi_registered = s_ip_registered = false;
    s_network_initialized = false;
    atomic_store(&s_address, 0);
    atomic_store(&s_network_epoch, 0);
    atomic_store(&s_scan_done, false);
    atomic_store(&s_disconnected, false);
    atomic_store(&s_expected_disconnect, false);
    atomic_store(&s_intentional_disconnect, false);
    s_seen_network_epoch = s_tcp_epoch = 0;
    s_retry_at = s_attempt_at = 0;
    s_attempts = 0;
    s_reconnect = true;
    s_profile_ready = false;
    s_scan_requested = false;
    s_scan_deadline = 0;
    s_profile_pending = s_joining = s_connected_once = false;
    s_config_attempts = 0;
    atomic_store(&s_accept_ip, false);
    s_listener = s_client = -1;
    s_client_activity_ms = 0;
    atomic_uint *diagnostic_counters[] = {&s_diag_connects, &s_diag_disconnects, &s_diag_beacons,
        &s_diag_reason, &s_diag_disconnect_ms, &s_diag_beacon_ms, &s_diag_alloc_failures,
        &s_diag_alloc_size, &s_diag_alloc_caps, &s_diag_tx_ok, &s_diag_tx_fail, &s_diag_tx_ms};
    for (size_t i = 0; i < sizeof(diagnostic_counters) / sizeof(diagnostic_counters[0]); i++) {
        atomic_store(diagnostic_counters[i], 0);
    }
    atomic_store(&s_diag_heap_hook_error, ESP_ERR_INVALID_STATE);
    atomic_store(&s_diag_tx_hook_error, ESP_ERR_INVALID_STATE);
    s_diag_heap_hook_installed = false;
    atomic_flag_clear(&s_diag_busy);
    memset(&s_diag_tcp, 0, sizeof(s_diag_tcp));
}

static void connected(void) {
    reset();
    s_initialized = s_started = true;
    s_network_initialized = true;
    s_view.connected = true;
    atomic_store(&s_address, address(0xc0a8010au));
    atomic_store(&s_network_epoch, 7);
    s_seen_network_epoch = 7;
    s_tcp_epoch = 50;
    s_listener = 10;
    s_client = 11;
    s_reconnect = false;
    s_profile_ready = true;
    s_connected_once = true;
    atomic_store(&s_accept_ip, true);
    assert(qdd_wifi_tcp_live());
}

static void inject_got_ip(uint32_t host) {
    memcpy(m.associated_ap.ssid, m.station_config.sta.ssid, sizeof(m.station_config.sta.ssid));
    ip_event_got_ip_t got = {.esp_netif = s_netif, .ip_info.ip.addr = address(host)};
    event(NULL, IP_EVENT, IP_EVENT_STA_GOT_IP, &got);
}

static void test_event_epoch_fail_closed(void) {
    uint8_t buffer[16];
    for (unsigned variant = 0; variant < 3; variant++) {
        connected();
        const mock_t before = m;
        const qdd_wifi_credentials_t credentials_before = s_credentials;
        const qdd_wifi_view_t view_before = s_view;
        if (variant < 2) {
            event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, NULL);
            inject_got_ip(variant == 0 ? 0xc0a8010au : 0xc0a80163u);
        } else event(NULL, IP_EVENT, IP_EVENT_STA_LOST_IP, NULL);
        assert(memcmp(&before, &m, sizeof(m)) == 0); // Event callbacks only atomics.
        assert(memcmp(&credentials_before, &s_credentials, sizeof(s_credentials)) == 0);
        assert(memcmp(&view_before, &s_view, sizeof(s_view)) == 0);
        assert(s_client == 11 && s_listener == 10 && s_tcp_epoch == 50);
        assert(!qdd_wifi_tcp_live()); // Same-IP reassociation is also stale.
        assert(qdd_wifi_read(buffer, sizeof(buffer)) == 0);
        assert(m.recv_calls == 0 && m.close_calls[11] == 1);
        assert(qdd_wifi_tcp_epoch() == 51 && !qdd_wifi_write("ack", 3));
        assert(m.send_calls == 0 && m.close_calls[11] == 1);
        qdd_wifi_poll(1000, false);
        assert(m.close_calls[10] == 1 && m.close_calls[11] == 1);
        assert(s_seen_network_epoch == atomic_load(&s_network_epoch));
        assert(qdd_wifi_view().connected == (variant < 2));
        if (variant < 2) {
            assert(!qdd_wifi_view().failed); // Batched disconnect/GOT_IP keeps new lease.
            assert(strcmp(qdd_wifi_view().ip, variant == 0 ? "192.168.1.10" : "192.168.1.99") == 0);
            assert(m.socket_calls == 1 && m.bound_address == atomic_load(&s_address));
            m.next_accepted = 21;
            qdd_wifi_poll(1001, false);
            assert(qdd_wifi_tcp_live() && qdd_wifi_tcp_epoch() == 52);
            assert(m.send_calls == 0 && m.recv_calls == 0); // No implicit protocol/HID action.
        } else {
            assert(m.socket_calls == 0 && qdd_wifi_view().ip[0] == 0);
        }
    }
    connected();
    const mock_t before = m;
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, NULL);
    inject_got_ip(0xc0a8010au);
    assert(memcmp(&before, &m, sizeof(m)) == 0);
    assert(!qdd_wifi_write("ack", 3)); // Write dispatch independently checks the epoch.
    assert(m.send_calls == 0 && m.close_calls[11] == 1 && qdd_wifi_tcp_epoch() == 51);
    assert(qdd_wifi_read(buffer, sizeof(buffer)) == 0 && m.recv_calls == 0);
    qdd_wifi_close_client();
    assert(m.close_calls[11] == 1);

    connected();
    const mock_t scan_before = m;
    event(NULL, WIFI_EVENT, WIFI_EVENT_SCAN_DONE, NULL);
    event(NULL, WIFI_EVENT, 999, NULL);
    event(NULL, IP_EVENT, 999, NULL);
    assert(memcmp(&scan_before, &m, sizeof(m)) == 0);
    assert(atomic_load(&s_scan_done) && qdd_wifi_tcp_live());
}

static void test_socket_io_failures(void) {
    uint8_t buffer[16];
    connected();
    m.recv_result = 4;
    assert(qdd_wifi_read(buffer, sizeof(buffer)) == 4 && memcmp(buffer, "RRRR", 4) == 0);
    assert(qdd_wifi_tcp_live());
    m.recv_result = -1;
    m.recv_error = EAGAIN;
    assert(qdd_wifi_read(buffer, sizeof(buffer)) == 0 && qdd_wifi_tcp_live());
    m.recv_error = EWOULDBLOCK;
    assert(qdd_wifi_read(buffer, sizeof(buffer)) == 0 && qdd_wifi_tcp_live());
    m.recv_result = 0;
    assert(qdd_wifi_read(buffer, sizeof(buffer)) == 0 && !qdd_wifi_tcp_live());
    assert(m.close_calls[11] == 1 && qdd_wifi_tcp_epoch() == 51);
    const int fatal[] = {ECONNRESET, EINTR, EBADF};
    for (size_t i = 0; i < sizeof(fatal) / sizeof(fatal[0]); i++) {
        connected();
        m.recv_error = fatal[i];
        assert(qdd_wifi_read(buffer, sizeof(buffer)) == 0 && !qdd_wifi_tcp_live());
        assert(m.recv_calls == 1 && m.close_calls[11] == 1);
    }
    connected();
    assert(qdd_wifi_write("ack", 3) && qdd_wifi_tcp_live());
    assert(m.send_calls == 1 && m.close_calls[11] == 0);
    const ssize_t short_writes[] = {0, 1, 2, -1};
    for (size_t i = 0; i < sizeof(short_writes) / sizeof(short_writes[0]); i++) {
        connected();
        m.send_result = short_writes[i];
        m.send_error = EAGAIN;
        assert(!qdd_wifi_write("ack", 3));
        assert(m.send_calls == 1 && m.close_calls[11] == 1 && qdd_wifi_tcp_epoch() == 51);
        assert(!qdd_wifi_write("ack", 3) && m.send_calls == 1); // No retries/queued acknowledgement.
    }
    connected();
    s_started = false;
    qdd_wifi_close_client();
    qdd_wifi_close_client();
    assert(m.close_calls[11] == 1 && m.sdk_calls[SDK_POWER] == 0);
}

static void test_listener_and_single_peer(void) {
    connected();
    m.next_accepted = 12;
    qdd_wifi_poll(1000, false);
    assert(m.close_calls[12] == 1 && s_client == 11 && qdd_wifi_tcp_epoch() == 50);
    assert(m.nonblock_calls == 1 && m.sdk_calls[SDK_POWER] == 0);
    const uint32_t rejected[] = {0x08080808u, 0u, 0xa9fe0102u, 0xe0000001u};
    for (size_t i = 0; i < sizeof(rejected) / sizeof(rejected[0]); i++) {
        connected();
        s_client = -1;
        m.next_accepted = 12;
        m.peer_address = address(rejected[i]);
        qdd_wifi_poll(1000, false);
        assert(m.close_calls[12] == 1 && s_client == -1 && qdd_wifi_tcp_epoch() == 50);
    }
    connected();
    s_client = -1;
    m.next_accepted = 12;
    m.fail_nonblock_fd = 12;
    qdd_wifi_poll(1000, false);
    assert(m.close_calls[12] == 1 && s_client == -1);
    connected();
    s_client = -1;
    m.next_accepted = 12;
    qdd_wifi_poll(1000, false);
    assert(s_client == 12 && qdd_wifi_tcp_epoch() == 51 && m.last_power == WIFI_PS_NONE);
    const unsigned power_calls = m.sdk_calls[SDK_POWER];
    qdd_wifi_close_client();
    assert(m.close_calls[12] == 1 && m.last_power == WIFI_PS_NONE);
    assert(m.sdk_calls[SDK_POWER] == power_calls); // HTTP and USB must not inherit modem sleep.

    for (unsigned fault = 0; fault < 4; fault++) {
        connected();
        s_client = s_listener = -1;
        m.socket_failure = fault == 0;
        m.fail_nonblock_fd = fault == 1 ? 20 : -1;
        m.bind_failure = fault == 2;
        m.listen_failure = fault == 3;
        qdd_wifi_poll(1000, false);
        assert(m.socket_calls == 1 && s_listener == -1);
        assert(m.close_calls[20] == (fault == 0 ? 0u : 1u));
    }
    connected();
    s_client = s_listener = -1;
    atomic_store(&s_address, address(0x08080808u));
    qdd_wifi_poll(1000, false);
    assert(m.socket_calls == 0 && s_listener == -1);
}

static void test_idle_observer_replaced_by_valid_peer(void) {
    connected();
    qdd_wifi_close_client();
    m.next_accepted = 12;
    qdd_wifi_poll(1000, false);
    assert(s_client == 12);
    const uint32_t accepted_epoch = qdd_wifi_tcp_epoch();
    m.next_accepted = 13;
    qdd_wifi_poll(2501, false);
    assert(s_client == 13 && m.close_calls[12] == 1 && m.close_calls[13] == 0);
    assert(qdd_wifi_tcp_epoch() == accepted_epoch + 2);
    assert(s_client_activity_ms == 2501);
    assert(m.recv_calls == 0 && m.send_calls == 0); // No handshake or HID input is synthesized.
    assert(m.nvs_erase_calls == 0 && m.bond_marker == 0xa1b2c3d4u);
}

static void observer_accepted_at(uint64_t now_ms) {
    connected();
    qdd_wifi_close_client();
    m.next_accepted = 12;
    qdd_wifi_poll(now_ms, false);
    assert(s_client == 12 && s_client_activity_ms == now_ms);
}

static void test_observer_admission_protects_owner_fresh_and_invalid(void) {
    const uint64_t protected_times[] = {0, 999, 1000, 2499, 2500};
    for (size_t i = 0; i < sizeof(protected_times) / sizeof(protected_times[0]); i++) {
        observer_accepted_at(1000);
        const uint32_t epoch = qdd_wifi_tcp_epoch();
        m.next_accepted = 13;
        qdd_wifi_poll(protected_times[i], false);
        assert(s_client == 12 && m.close_calls[12] == 0 && m.close_calls[13] == 1);
        assert(qdd_wifi_tcp_epoch() == epoch && s_client_activity_ms == 1000);
    }
    observer_accepted_at(1000);
    const uint32_t owned_epoch = qdd_wifi_tcp_epoch();
    m.next_accepted = 13;
    qdd_wifi_poll(100000, true); // A paused/unarmed TCP owner still owns the slot.
    assert(s_client == 12 && m.close_calls[12] == 0 && m.close_calls[13] == 1);
    assert(qdd_wifi_tcp_epoch() == owned_epoch && s_client_activity_ms == 1000);

    const uint32_t rejected[] = {0x08080808u, 0u, 0xa9fe0102u, 0xe0000001u};
    for (size_t i = 0; i < sizeof(rejected) / sizeof(rejected[0]); i++) {
        observer_accepted_at(1000);
        const uint32_t epoch = qdd_wifi_tcp_epoch();
        const unsigned nonblocks = m.nonblock_calls;
        m.next_accepted = 13;
        m.peer_address = address(rejected[i]);
        qdd_wifi_poll(2501, false);
        assert(s_client == 12 && m.close_calls[12] == 0 && m.close_calls[13] == 1);
        assert(qdd_wifi_tcp_epoch() == epoch && s_client_activity_ms == 1000);
        assert(m.nonblock_calls == nonblocks); // Invalid peers do not reach socket admission.
    }
    observer_accepted_at(1000);
    const uint32_t failed_epoch = qdd_wifi_tcp_epoch();
    m.next_accepted = 13;
    m.fail_nonblock_fd = 13;
    qdd_wifi_poll(2501, false);
    assert(s_client == 12 && m.close_calls[12] == 0 && m.close_calls[13] == 1);
    assert(qdd_wifi_tcp_epoch() == failed_epoch && s_client_activity_ms == 1000);
}

static void test_observer_activity_is_per_client_and_rx_only(void) {
    uint8_t bytes[16];
    observer_accepted_at(1000);
    m.now_us = 2400000;
    m.recv_result = 3;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 3 && s_client_activity_ms == 2400);
    m.next_accepted = 13;
    qdd_wifi_poll(3900, false);
    assert(s_client == 12 && m.close_calls[13] == 1); // Successful RX extends freshness.
    m.next_accepted = 14;
    qdd_wifi_poll(3901, false);
    assert(s_client == 14 && m.close_calls[12] == 1 && s_client_activity_ms == 3901);

    qdd_wifi_close_client();
    m.next_accepted = 15;
    qdd_wifi_poll(5000, false);
    assert(s_diag_tcp.rx_ms == 2400 && s_client_activity_ms == 5000);
    m.next_accepted = 16;
    qdd_wifi_poll(6500, false);
    assert(s_client == 15 && m.close_calls[16] == 1); // The old client's RX age cannot evict a new one.
    m.next_accepted = 17;
    qdd_wifi_poll(6501, false);
    assert(s_client == 17 && m.close_calls[15] == 1);

    observer_accepted_at(1000);
    m.now_us = 2400000;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0 && s_client_activity_ms == 1000);
    m.recv_error = EWOULDBLOCK;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0 && s_client_activity_ms == 1000);
    assert(qdd_wifi_write("ack", 3) && s_client_activity_ms == 1000);
    m.next_accepted = 13;
    qdd_wifi_poll(2499, false);
    assert(s_client == 12 && s_client_activity_ms == 1000);
    m.next_accepted = 14;
    qdd_wifi_poll(2501, false);
    assert(s_client == 14 && m.close_calls[12] == 1); // Neither TX nor rejected peers refresh RX activity.

    observer_accepted_at(1000);
    const uint32_t epoch = qdd_wifi_tcp_epoch();
    qdd_wifi_poll(100000, false);
    assert(s_client == 12 && qdd_wifi_tcp_epoch() == epoch && m.close_calls[12] == 0);
    // Idle alone never closes an observer; a validated new peer must actually arrive.
}

static void test_observer_zero_and_64bit_activity_boundaries(void) {
    observer_accepted_at(0);
    m.next_accepted = 13;
    qdd_wifi_poll(QDD_HEARTBEAT_MS, false);
    assert(s_client == 12 && m.close_calls[13] == 1); // A timestamp of zero is valid.
    m.next_accepted = 14;
    qdd_wifi_poll(QDD_HEARTBEAT_MS + 1u, false);
    assert(s_client == 14 && m.close_calls[12] == 1);

    const uint64_t accepted_at = (uint64_t)UINT32_MAX - 100u;
    const uint64_t received_at = accepted_at + 200u;
    observer_accepted_at(accepted_at);
    uint8_t bytes[16];
    m.now_us = (int64_t)(received_at * 1000u);
    m.recv_result = 2;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 2);
    assert(s_client_activity_ms == received_at && s_diag_tcp.rx_ms == (uint32_t)received_at);
    m.next_accepted = 13;
    qdd_wifi_poll(received_at - 1u, false);
    assert(s_client == 12 && m.close_calls[13] == 1); // No unsigned underflow on a regressed clock.
    m.next_accepted = 14;
    qdd_wifi_poll(received_at + QDD_HEARTBEAT_MS, false);
    assert(s_client == 12 && m.close_calls[14] == 1);
    m.next_accepted = 15;
    qdd_wifi_poll(received_at + QDD_HEARTBEAT_MS + 1u, false);
    assert(s_client == 15 && m.close_calls[12] == 1);
}

static qdd_wifi_credentials_t credentials(void) {
    const qdd_wifi_credentials_t value = {.ssid = "Test Wi-Fi", .password = "test password"};
    return value;
}

static void seed_profile(void) {
    m.profile = credentials();
    m.profile_present = true;
    m.profile_size = sizeof(m.profile);
}

static void test_nvs_profile_isolation(void) {
    reset();
    assert(qdd_wifi_start() == ESP_OK && !s_started && !qdd_wifi_view().configured);
    assert(m.nvs_get_calls == 1 && m.nvs_close_calls == 1 && m.nvs_erase_calls == 0);
    reset();
    m.open_result = ESP_ERR_NVS_NOT_FOUND;
    assert(qdd_wifi_start() == ESP_OK && m.nvs_get_calls == 0 && !s_started);
    reset();
    seed_profile();
    m.profile_size--;
    assert(qdd_wifi_start() == ESP_ERR_INVALID_STATE && !s_started);
    assert(qdd_wifi_view().failed && !qdd_wifi_view().configured && m.profile_present);
    assert(m.nvs_erase_calls == 0);
    reset();
    seed_profile();
    memset(m.profile.password, 'x', sizeof(m.profile.password));
    assert(qdd_wifi_start() == ESP_ERR_INVALID_STATE && !s_started && m.profile_present);
    for (size_t i = 0; i < sizeof(s_credentials); i++) assert(((uint8_t *)&s_credentials)[i] == 0);
    reset();
    seed_profile();
    assert(qdd_wifi_start() == ESP_OK && s_started && qdd_wifi_view().configured);
    assert(m.sdk_calls[SDK_POWER] == 1 && m.last_power == WIFI_PS_NONE);
    assert(m.storage == WIFI_STORAGE_RAM && m.nvs_set_calls == 0 && m.nvs_erase_calls == 0);
    assert(memcmp(m.station_config.sta.ssid, "Test Wi-Fi", 10) == 0);
    assert(m.station_config.sta.threshold.authmode == WIFI_AUTH_WPA2_PSK);
    assert(m.station_config.sta.pmf_cfg.capable && !m.station_config.sta.pmf_cfg.required);

    qdd_wifi_credentials_t next = credentials();
    strcpy(next.ssid, "Replacement");
    reset();
    seed_profile();
    next.password[0] = 0;
    assert(qdd_wifi_save(&next) == ESP_OK && m.nvs_set_calls == 1 && m.nvs_commit_calls == 1);
    assert(m.profile_present && strcmp(m.profile.ssid, "Replacement") == 0);
    assert(m.station_config.sta.threshold.authmode == WIFI_AUTH_OPEN);
    assert(m.bond_marker == 0xa1b2c3d4u && m.nvs_erase_calls == 0);

    for (unsigned fault = 0; fault < 3; fault++) {
        reset();
        seed_profile();
        if (fault == 0) m.open_result = ESP_FAIL;
        if (fault == 1) m.set_result = ESP_FAIL;
        if (fault == 2) m.commit_result = ESP_FAIL;
        assert(qdd_wifi_save(&next) == ESP_FAIL && !s_started && !qdd_wifi_view().configured);
        assert(strcmp(m.profile.ssid, "Test Wi-Fi") == 0);
        assert(m.nvs_commit_calls == (fault == 2 ? 1u : 0u));
        assert(m.bond_marker == 0xa1b2c3d4u);
    }
    reset();
    next.ssid[0] = 0;
    assert(qdd_wifi_save(&next) == ESP_ERR_INVALID_ARG && m.nvs_open_calls == 0);
    reset();
    seed_profile();
    s_credentials = m.profile;
    s_view.configured = true;
    assert(qdd_wifi_clear() == ESP_OK && !m.profile_present && !qdd_wifi_view().configured);
    assert(m.nvs_erase_calls == 1 && m.nvs_set_calls == 0 && m.nvs_commit_calls == 1);
    assert(m.bond_marker == 0xa1b2c3d4u);
    for (size_t i = 0; i < sizeof(s_credentials); i++) assert(((uint8_t *)&s_credentials)[i] == 0);
    connected();
    seed_profile();
    s_credentials = m.profile;
    s_view.configured = true;
    assert(qdd_wifi_clear() == ESP_OK && !m.profile_present && !s_started);
    assert(!qdd_wifi_tcp_live() && m.close_calls[11] == 1 && m.close_calls[10] == 1);
    assert(qdd_wifi_tcp_epoch() == 51 && m.sdk_calls[SDK_STOP] == 1 && m.sdk_calls[SDK_DEINIT] == 1);
    assert(m.bond_marker == 0xa1b2c3d4u);
    reset();
    m.erase_result = ESP_ERR_NVS_NOT_FOUND;
    assert(qdd_wifi_clear() == ESP_OK && m.nvs_commit_calls == 1);
    connected();
    seed_profile();
    s_credentials = m.profile;
    s_view.configured = true;
    m.commit_result = ESP_FAIL;
    assert(qdd_wifi_clear() == ESP_FAIL && qdd_wifi_tcp_live());
    assert(m.profile_present && qdd_wifi_view().configured && m.close_calls[11] == 0);
    reset();
    assert(qdd_wifi_retry() == ESP_ERR_INVALID_STATE && m.sdk_calls[SDK_CONFIG] == 0);
}

static void test_stack_cleanup_and_scanning(void) {
    for (int failure = SDK_NETIF_INIT; failure <= SDK_START; failure++) {
        reset();
        m.failure_step = failure;
        const esp_err_t error = qdd_wifi_scan();
        assert(error == (failure == SDK_NETIF_NEW ? ESP_ERR_NO_MEM : ESP_FAIL));
        assert(!s_started && !s_initialized && !s_wifi_registered && !s_ip_registered && !s_netif);
        assert(m.nvs_erase_calls == 0 && m.nvs_set_calls == 0);
        if (failure > SDK_WIFI_INIT) assert(m.sdk_calls[SDK_DEINIT] == 1);
        if (failure > SDK_REGISTER_WIFI) assert(m.sdk_calls[SDK_UNREGISTER] >= 1);
    }
    reset();
    m.loop_result = ESP_ERR_INVALID_STATE;
    assert(qdd_wifi_scan() == ESP_OK && s_started && qdd_wifi_view().scanning);
    assert(!s_reconnect && m.sdk_calls[SDK_SCAN] == 0); // Worker performs asynchronous scan.
    m.scan_result = ESP_ERR_WIFI_STATE;
    qdd_wifi_poll(1000, false);
    qdd_wifi_poll(5999, false);
    assert(qdd_wifi_view().scanning && m.sdk_calls[SDK_SCAN] == 2);
    qdd_wifi_poll(6000, false);
    assert(!qdd_wifi_view().scanning && qdd_wifi_view().failed);
    assert(m.sdk_calls[SDK_CONNECT] == 0);

    reset();
    s_view.configured = s_view.connecting = true;
    s_profile_ready = true;
    assert(qdd_wifi_scan() == ESP_OK && m.sdk_calls[SDK_DISCONNECT] == 1);
    qdd_wifi_poll(1000, false);
    assert(m.sdk_calls[SDK_SCAN] == 1 && qdd_wifi_view().scanning);
    m.record_count = 4;
    strcpy((char *)m.records[0].ssid, "weak");
    m.records[0].rssi = -90;
    m.records[0].authmode = WIFI_AUTH_WPA2_PSK;
    strcpy((char *)m.records[1].ssid, "strong");
    m.records[1].rssi = -30;
    m.records[1].bssid[5] = 42;
    m.records[1].authmode = WIFI_AUTH_OPEN;
    memset(m.records[2].ssid, 'x', sizeof(m.records[2].ssid)); // Unterminated SDK record.
    m.records[2].rssi = -20;
    m.records[3].rssi = -10; // Hidden/empty SSID omitted explicitly.
    event(NULL, WIFI_EVENT, WIFI_EVENT_SCAN_DONE, NULL);
    qdd_wifi_poll(1100, false);
    const qdd_wifi_view_t view = qdd_wifi_view();
    assert(!view.scanning && !view.failed && view.count == 2);
    qdd_wifi_ap_t strongest, weakest;
    assert(qdd_wifi_ap(0, view.scan_revision, &strongest));
    assert(qdd_wifi_ap(1, view.scan_revision, &weakest));
    assert(strcmp(strongest.ssid, "strong") == 0 && strongest.open);
    assert(strongest.bssid[5] == 42 && strongest.rssi == -30);
    assert(strcmp(weakest.ssid, "weak") == 0 && !weakest.open);
    assert(m.sdk_calls[SDK_SCAN_CLEAR] == 1 && m.sdk_calls[SDK_CONNECT] == 0);
    assert(m.records_freed == m.record_count);
    qdd_wifi_allow_reconnect(true);
    qdd_wifi_poll(1200, false);
    assert(m.sdk_calls[SDK_CONNECT] == 1 && qdd_wifi_view().connecting);
    qdd_wifi_poll(13200, false);
    assert(m.sdk_calls[SDK_DISCONNECT] == 2 && !qdd_wifi_view().failed);
    qdd_wifi_poll(13699, false);
    assert(m.sdk_calls[SDK_CONNECT] == 1);
    qdd_wifi_poll(13700, false);
    assert(m.sdk_calls[SDK_CONNECT] == 2 && qdd_wifi_view().connecting);
}

static void complete_scan(void) {
    assert(qdd_wifi_scan() == ESP_OK);
    qdd_wifi_poll(1000, false);
    event(NULL, WIFI_EVENT, WIFI_EVENT_SCAN_DONE, NULL);
    qdd_wifi_poll(1100, false);
}

static void test_scan_distinct_capacity_and_revision(void) {
    // A compact status getter must not reintroduce multi-KiB copies on the
    // 3–4 KiB embedded task stacks when the independent AP cache grows.
    assert(sizeof(qdd_wifi_view_t) < 96);
    reset();
    m.record_count = 24;
    for (uint16_t i = 0; i < m.record_count; i++) {
        snprintf((char *)m.records[i].ssid, sizeof(m.records[i].ssid), "Network-%02u", (unsigned)i);
        m.records[i].rssi = (int8_t)(-100 + i * 2);
        m.records[i].bssid[5] = (uint8_t)i;
        m.records[i].authmode = WIFI_AUTH_WPA2_PSK;
    }
    complete_scan();
    qdd_wifi_view_t view = qdd_wifi_view();
    assert(view.count == 24 && !view.failed);
    for (uint8_t i = 0; i < view.count; i++) {
        qdd_wifi_ap_t ap;
        assert(qdd_wifi_ap(i, view.scan_revision, &ap));
        assert(ap.bssid[5] == 23 - i && ap.rssi == -54 - i * 2);
    }
    qdd_wifi_ap_t ap;
    assert(!qdd_wifi_ap(view.count, view.scan_revision, &ap));
    assert(m.sdk_calls[SDK_SCAN_RECORDS] == 24 && m.records_freed == 24);

    reset();
    m.record_count = 40;
    for (uint16_t i = 0; i < 20; i++) {
        strcpy((char *)m.records[i].ssid, "Repeated mesh");
        m.records[i].rssi = (int8_t)(-100 + i);
        m.records[i].bssid[5] = (uint8_t)i;
        m.records[i].authmode = WIFI_AUTH_WPA2_PSK;
        snprintf((char *)m.records[i + 20].ssid, sizeof(m.records[i + 20].ssid), "Distinct-%02u", (unsigned)i);
        m.records[i + 20].rssi = (int8_t)(-60 + i);
    }
    complete_scan();
    view = qdd_wifi_view();
    assert(view.count == 21 && m.records_freed == 40);
    assert(qdd_wifi_ap(20, view.scan_revision, &ap));
    assert(strcmp(ap.ssid, "Repeated mesh") == 0 && ap.rssi == -81 && ap.bssid[5] == 19 && !ap.open);

    reset();
    m.record_count = 97;
    for (uint16_t i = 0; i < 96; i++) {
        snprintf((char *)m.records[i].ssid, sizeof(m.records[i].ssid), "Dense-%03u", (unsigned)i);
        m.records[i].rssi = (int8_t)(-120 + i);
        m.records[i].bssid[5] = (uint8_t)i;
    }
    strcpy((char *)m.records[96].ssid, "Dense-095");
    m.records[96].rssi = -1;
    m.records[96].bssid[5] = 200;
    m.records[96].authmode = WIFI_AUTH_OPEN;
    complete_scan();
    view = qdd_wifi_view();
    assert(view.count == 64 && m.records_freed == 97 && m.sdk_calls[SDK_SCAN_RECORDS] == 97);
    assert(qdd_wifi_ap(0, view.scan_revision, &ap));
    assert(strcmp(ap.ssid, "Dense-095") == 0 && ap.rssi == -1 && ap.bssid[5] == 200 && ap.open);
    assert(qdd_wifi_ap(63, view.scan_revision, &ap));
    assert(strcmp(ap.ssid, "Dense-032") == 0 && ap.rssi == -88);
    for (uint8_t i = 1; i < view.count; i++) {
        qdd_wifi_ap_t previous;
        assert(qdd_wifi_ap((uint8_t)(i - 1), view.scan_revision, &previous));
        assert(qdd_wifi_ap(i, view.scan_revision, &ap));
        assert(previous.rssi >= ap.rssi);
    }
    assert(!qdd_wifi_ap(64, view.scan_revision, &ap));
    const uint32_t old_revision = view.scan_revision;
    m.record_count = 1;
    memset(m.records, 0, sizeof(m.records));
    strcpy((char *)m.records[0].ssid, "After rescan");
    m.records[0].rssi = -40;
    complete_scan();
    view = qdd_wifi_view();
    assert(view.count == 1 && view.scan_revision != old_revision);
    assert(!qdd_wifi_ap(0, old_revision, &ap));
    assert(qdd_wifi_ap(0, view.scan_revision, &ap) && strcmp(ap.ssid, "After rescan") == 0);
}

static void test_scan_record_cleanup(void) {
    reset();
    complete_scan();
    assert(qdd_wifi_view().count == 0 && !qdd_wifi_view().failed);
    assert(m.sdk_calls[SDK_SCAN_COUNT] == 1 && m.sdk_calls[SDK_SCAN_RECORDS] == 0);
    assert(m.sdk_calls[SDK_SCAN_CLEAR] == 1);
    for (unsigned fault = 0; fault < 2; fault++) {
        reset();
        m.record_count = 20;
        m.failure_step = fault == 0 ? SDK_SCAN_COUNT : SDK_SCAN_RECORDS;
        complete_scan();
        assert(qdd_wifi_view().failed && !qdd_wifi_view().scanning && qdd_wifi_view().count == 0);
        assert(m.sdk_calls[SDK_SCAN_CLEAR] == 1 && m.records_freed == 20);
    }
}

static void test_requested_network_change_is_not_a_failure(void) {
    connected();
    const qdd_wifi_credentials_t credentials = {.ssid = "new-network", .password = "12345678"};
    assert(qdd_wifi_save(&credentials) == ESP_OK);
    const wifi_event_sta_disconnected_t leaving = {.reason = WIFI_REASON_ASSOC_LEAVE};
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&leaving);
    qdd_wifi_poll(1000, false);
    assert(!qdd_wifi_view().failed && qdd_wifi_view().connecting);
    assert(m.sdk_calls[SDK_CONNECT] == 1 && m.close_calls[11] == 1);
    inject_got_ip(0xc0a80114u);
    qdd_wifi_poll(1005, false);
    assert(qdd_wifi_view().connected && !qdd_wifi_view().failed);
    assert(!qdd_wifi_tcp_live()); // New network does not inherit the controller.
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&leaving);
    qdd_wifi_poll(1010, false);
    assert(!qdd_wifi_view().failed && qdd_wifi_view().connecting);
    assert(m.sdk_calls[SDK_CONNECT] == 1); // Real AP loss uses reconnect backoff.

    connected();
    assert(qdd_wifi_save(&credentials) == ESP_OK);
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&leaving);
    qdd_wifi_poll(1000, false);
    // A transient authentication failure stays in the initial retry run.
    const wifi_event_sta_disconnected_t authentication = {.reason = 15};
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&authentication);
    qdd_wifi_poll(1010, false);
    assert(!qdd_wifi_view().failed && qdd_wifi_view().connecting);
    assert(m.sdk_calls[SDK_CONNECT] == 1);
    qdd_wifi_poll(1509, false);
    assert(m.sdk_calls[SDK_CONNECT] == 1);
    qdd_wifi_poll(1510, false);
    assert(m.sdk_calls[SDK_CONNECT] == 2);
    connected();
    assert(qdd_wifi_save(&credentials) == ESP_OK);
    qdd_wifi_poll(1000, false);
    inject_got_ip(0xc0a80114u); // Even if the SDK emits no leave event, clear the intent.
    qdd_wifi_poll(1005, false);
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&leaving);
    qdd_wifi_poll(1010, false);
    assert(!qdd_wifi_view().failed && qdd_wifi_view().connecting);
    assert(m.sdk_calls[SDK_CONNECT] == 1);
}

static void test_failed_configuration_cannot_reconnect_old_profile(void) {
    connected();
    const qdd_wifi_credentials_t credentials = {.ssid = "new-network", .password = "12345678"};
    m.config_result = ESP_FAIL;
    assert(qdd_wifi_save(&credentials) == ESP_FAIL);
    const wifi_event_sta_disconnected_t leaving = {.reason = WIFI_REASON_ASSOC_LEAVE};
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&leaving);
    qdd_wifi_poll(1000, false);
    assert(qdd_wifi_view().failed && !qdd_wifi_view().connecting);
    assert(m.sdk_calls[SDK_CONNECT] == 0);
    qdd_wifi_allow_reconnect(true); // Returning home must not bypass a failed apply.
    qdd_wifi_poll(31000, false);
    assert(m.sdk_calls[SDK_CONNECT] == 0);
    inject_got_ip(0xc0a8010au); // A delayed old association is never a controller.
    qdd_wifi_poll(31010, false);
    assert(!qdd_wifi_view().connected && !qdd_wifi_tcp_live());
    m.config_result = ESP_OK;
    assert(qdd_wifi_retry() == ESP_OK);
    event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&leaving);
    qdd_wifi_poll(32000, false);
    assert(qdd_wifi_view().connecting && !qdd_wifi_view().failed);
    assert(m.sdk_calls[SDK_CONNECT] == 1);
}

static void test_initial_retry_budget_and_recovery(void) {
    reset();
    const qdd_wifi_credentials_t credentials = {.ssid = "retry-network", .password = "12345678"};
    assert(qdd_wifi_save(&credentials) == ESP_OK);
    assert(m.station_config.sta.scan_method == WIFI_ALL_CHANNEL_SCAN);
    assert(m.station_config.sta.sort_method == WIFI_CONNECT_AP_BY_SIGNAL);
    assert(!m.station_config.sta.bssid_set);
    qdd_wifi_poll(1000, false);
    const wifi_event_sta_disconnected_t failure = {.reason = 15};
    const uint64_t failures[] = {1010, 1520, 2530, 4540};
    const uint64_t retries[] = {1510, 2520, 4530};
    for (unsigned i = 0; i < 4; i++) {
        assert(m.sdk_calls[SDK_CONNECT] == i + 1);
        event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&failure);
        qdd_wifi_poll(failures[i], false);
        assert(qdd_wifi_view().connecting == (i < 3));
        assert(qdd_wifi_view().failed == (i == 3));
        if (i < 3) {
            qdd_wifi_poll(retries[i] - 1, false);
            assert(m.sdk_calls[SDK_CONNECT] == i + 1);
            qdd_wifi_poll(retries[i], false);
        }
    }
    qdd_wifi_allow_reconnect(true);
    qdd_wifi_poll(100000, false);
    assert(m.sdk_calls[SDK_CONNECT] == 4 && qdd_wifi_view().failed);
    assert(m.profile_present && m.nvs_erase_calls == 0 && m.nvs_set_calls == 1);
    assert(qdd_wifi_retry() == ESP_OK);
    qdd_wifi_poll(100010, false);
    inject_got_ip(0xc0a80114u);
    qdd_wifi_poll(100020, false);
    assert(qdd_wifi_view().connected && !qdd_wifi_view().failed);
    // A previously connected network keeps recovering beyond the initial budget.
    for (unsigned i = 0; i < 6; i++) {
        const uint64_t now = 110000u + i * 40000u;
        event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&failure);
        qdd_wifi_poll(now, false);
        assert(qdd_wifi_view().connecting && !qdd_wifi_view().failed);
        qdd_wifi_poll(now + 30000u, false);
    }
    assert(m.sdk_calls[SDK_CONNECT] == 11 && m.nvs_erase_calls == 0);
}

static void test_immediate_failure_uses_short_retry(void) {
    reset();
    const qdd_wifi_credentials_t credentials = {.ssid = "retry-network", .password = "12345678"};
    assert(qdd_wifi_save(&credentials) == ESP_OK);
    m.connect_result = ESP_FAIL;
    qdd_wifi_poll(1000, false);
    assert(m.sdk_calls[SDK_CONNECT] == 1 && qdd_wifi_view().connecting && !qdd_wifi_view().failed);
    qdd_wifi_poll(1499, false);
    assert(m.sdk_calls[SDK_CONNECT] == 1);
    qdd_wifi_poll(1500, false);
    assert(m.sdk_calls[SDK_CONNECT] == 2 && !qdd_wifi_view().failed);
    m.connect_result = ESP_OK;
    qdd_wifi_poll(2499, false);
    assert(m.sdk_calls[SDK_CONNECT] == 2);
    qdd_wifi_poll(2500, false);
    assert(m.sdk_calls[SDK_CONNECT] == 3 && qdd_wifi_view().connecting);
    inject_got_ip(0xc0a80114u);
    qdd_wifi_poll(2510, false);
    assert(qdd_wifi_view().connected && !qdd_wifi_view().failed);
}

static void test_pending_configuration_and_stale_ip(void) {
    reset();
    const qdd_wifi_credentials_t credentials = {.ssid = "current-network", .password = "12345678"};
    m.config_result = ESP_ERR_WIFI_STATE;
    assert(qdd_wifi_save(&credentials) == ESP_OK);
    assert(qdd_wifi_view().connecting && !qdd_wifi_view().failed && !s_profile_ready);
    inject_got_ip(0xc0a80114u); // An old DHCP event before joining is ignored.
    qdd_wifi_poll(1000, false);
    assert(!qdd_wifi_view().connected && m.sdk_calls[SDK_CONNECT] == 0);
    assert(m.sdk_calls[SDK_CONFIG] == 2 && qdd_wifi_view().connecting);
    m.config_result = ESP_OK;
    qdd_wifi_poll(1249, false);
    assert(m.sdk_calls[SDK_CONFIG] == 2);
    qdd_wifi_poll(1250, false);
    assert(m.sdk_calls[SDK_CONFIG] == 3 && m.sdk_calls[SDK_CONNECT] == 1);
    assert(s_profile_ready && !qdd_wifi_view().failed);
    ip_event_got_ip_t wrong = {.esp_netif = NULL, .ip_info.ip.addr = address(0xc0a80114u)};
    event(NULL, IP_EVENT, IP_EVENT_STA_GOT_IP, &wrong);
    qdd_wifi_poll(1260, false);
    assert(!qdd_wifi_view().connected && m.socket_calls == 0);
    strcpy((char *)m.associated_ap.ssid, "old-network");
    wrong.esp_netif = s_netif;
    event(NULL, IP_EVENT, IP_EVENT_STA_GOT_IP, &wrong);
    qdd_wifi_poll(1270, false);
    assert(!qdd_wifi_view().connected && m.socket_calls == 0);
    inject_got_ip(0xc0a80114u);
    qdd_wifi_poll(1280, false);
    assert(qdd_wifi_view().connected && m.socket_calls == 1);
    assert(m.nvs_set_calls == 1 && m.nvs_erase_calls == 0);
}

static void test_diagnostics_without_started_wifi(void) {
    for (unsigned initialized = 0; initialized < 2; initialized++) {
        reset();
        s_initialized = initialized != 0;
        const mock_t before = m;
        for (unsigned sample = 0; sample < 3; sample++) {
            char json[QDD_WIFI_DIAGNOSTICS_MAX + 1];
            assert(qdd_wifi_diagnostics(json, sizeof(json)) > 0);
            for (unsigned getter = 0; getter < 4; getter++) assert(m.diagnostic_getters[getter] == 0);
            assert(strstr(json, initialized ? "\"rssi\":[12290,-127]" : "\"rssi\":[12289,-127]"));
            assert(strstr(json, "\"up\":0") && !s_started);
            assert(memcmp(&m, &before, sizeof(m)) == 0); // No SDK call or implicit setup.
        }
    }
}

static void test_diagnostics_numeric_callbacks_and_bounds(void) {
    reset();
    assert(qdd_wifi_scan() == ESP_OK);
    assert(m.tx_hook_calls == 1 && m.heap_hook_calls == 1 && m.tx_callback && m.heap_callback);
    assert(qdd_wifi_scan() == ESP_OK && m.tx_hook_calls == 1 && m.heap_hook_calls == 1);
    m.netif_up = true; m.actual_rssi = -60; m.actual_channel = 6;
    m.heap_free = 27624; m.heap_minimum = 24000; m.heap_largest = 15360;
    strcpy((char *)m.associated_ap.ssid, "NEVER_OUTPUT_NETWORK");
    strcpy(s_credentials.password, "NEVER_OUTPUT_PASSWORD");
    m.now_us = 100000; event(NULL, WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, NULL);
    const wifi_event_sta_disconnected_t lost = {.reason = 200};
    m.now_us = 200000; event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, (void *)&lost);
    m.now_us = 250000; event(NULL, WIFI_EVENT, WIFI_EVENT_STA_BEACON_TIMEOUT, NULL);
    const unsigned socket_calls = m.socket_calls;
    const qdd_wifi_view_t view = s_view;
    m.now_us = 300000; m.tx_callback(WIFI_IF_STA, NULL, NULL, true);
    m.now_us = 350000; m.tx_callback(99, NULL, NULL, false); // Ignore other interfaces.
    m.now_us = 390000; m.tx_callback(WIFI_IF_STA, NULL, NULL, false);
    m.heap_callback(1536, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, "NEVER_OUTPUT_FUNCTION");
    m.now_us = 400000;
    char json[QDD_WIFI_DIAGNOSTICS_MAX + 1];
    const size_t length = qdd_wifi_diagnostics(json, sizeof(json));
    assert(length && length == strlen(json) && length <= QDD_WIFI_DIAGNOSTICS_MAX);
    assert(json[0] == '{' && json[length - 1] == '}');
    assert(strstr(json, "\"rssi\":[0,-60]") && strstr(json, "\"ch\":[0,6]"));
    assert(strstr(json, "\"ps\":[0,0]") && strstr(json, "\"up\":1"));
    assert(strstr(json, "\"ev\":[1,1,1,200,200,150]"));
    assert(strstr(json, "\"heap\":[27624,24000,15360]"));
    assert(strstr(json, "\"oom\":[1,1536,2052]"));
    assert(strstr(json, "\"tx\":[0,1,1,10]") && strstr(json, "\"memHook\":0"));
    assert(!strstr(json, "NEVER_OUTPUT") && !strstr(json, "ssid") && !strstr(json, "password"));
    for (size_t i = 0; i < length; i++) assert((unsigned char)json[i] >= 32 && (unsigned char)json[i] <= 126);
    assert(m.socket_calls == socket_calls && memcmp(&view, &s_view, sizeof(view)) == 0);
    assert(strcmp(s_credentials.password, "NEVER_OUTPUT_PASSWORD") == 0);
    char bounded[QDD_WIFI_DIAGNOSTICS_MAX + 2];
    memset(bounded, 'X', sizeof(bounded));
    assert(qdd_wifi_diagnostics(bounded + 1, length + 1) == length);
    assert(bounded[0] == 'X' && bounded[length + 2] == 'X');
    assert(!qdd_wifi_diagnostics(bounded + 1, length) && bounded[1] == 0);
    assert(!qdd_wifi_diagnostics(NULL, 0));
    char one = 'X'; assert(!qdd_wifi_diagnostics(&one, 1) && one == 0);
    atomic_flag_test_and_set(&s_diag_busy);
    one = 'X'; assert(!qdd_wifi_diagnostics(&one, 1) && one == 0);
    assert(atomic_flag_test_and_set(&s_diag_busy)); // A rejected reader cannot unlock the owner.
    atomic_flag_clear(&s_diag_busy);
    stop_stack();
    assert(start_stack() == ESP_OK && m.heap_hook_calls == 1 && m.tx_hook_calls == 2);
}

static void test_diagnostics_stale_cache_api_failures_and_maximum(void) {
    connected();
    s_netif = &mock_netif;
    m.ap_result = 0x300f; m.rssi_result = ESP_FAIL; m.channel_result = ESP_FAIL;
    m.ps_result = ESP_FAIL; m.ip_result = ESP_FAIL;
    m.actual_rssi = 123; m.actual_channel = 255; m.last_power = 2;
    const qdd_wifi_view_t view = s_view;
    char json[QDD_WIFI_DIAGNOSTICS_MAX + 1];
    assert(qdd_wifi_diagnostics(json, sizeof(json)) > 0);
    assert(strstr(json, "\"ap\":12303") && strstr(json, "\"rssi\":[-1,-127]"));
    assert(strstr(json, "\"ch\":[-1,0]") && strstr(json, "\"ps\":[-1,-1]"));
    assert(strstr(json, "\"up\":0,\"ipErr\":-1") && strstr(json, "\"ev\":[0,0,0,0,-1,-1]"));
    assert(memcmp(&view, &s_view, sizeof(view)) == 0 && qdd_wifi_tcp_live()); // Observe, never repair.
    atomic_uint *maximums[] = {&s_diag_connects, &s_diag_disconnects, &s_diag_beacons, &s_diag_reason,
        &s_diag_alloc_failures, &s_diag_alloc_size, &s_diag_alloc_caps, &s_diag_tx_ok, &s_diag_tx_fail};
    for (size_t i = 0; i < sizeof(maximums) / sizeof(maximums[0]); i++) atomic_store(maximums[i], UINT_MAX);
    m.now_us = (int64_t)INT_MAX * 1000;
    m.ap_result = m.rssi_result = m.channel_result = m.ps_result = m.ip_result = INT_MIN;
    atomic_store(&s_diag_tx_hook_error, INT_MIN); atomic_store(&s_diag_heap_hook_error, INT_MIN);
    m.heap_free = m.heap_minimum = m.heap_largest = UINT_MAX;
    s_tcp_epoch = UINT_MAX;
    s_diag_tcp.rx_bytes = s_diag_tcp.tx_bytes = s_diag_tcp.tx_ok = s_diag_tcp.tx_fail = UINT_MAX;
    s_diag_tcp.last_errno = INT_MIN;
    s_diag_tcp.close_reason = TCP_CLOSE_SEND;
    const size_t length = qdd_wifi_diagnostics(json, sizeof(json));
    assert(length > 0 && length <= QDD_WIFI_DIAGNOSTICS_MAX);
    assert(strstr(json, "4294967295") && strstr(json, "-2147483648"));
    assert(strstr(json, "\"tcp\":[4294967295,4294967295,4294967295,4294967295,4294967295,2147483647,2147483647,-2147483648,5]"));
    reset();
    m.tx_hook_result = m.heap_hook_result = ESP_FAIL;
    assert(qdd_wifi_scan() == ESP_OK && s_started); // Diagnostic failure cannot disable Wi-Fi.
    assert(qdd_wifi_diagnostics(json, sizeof(json)) > 0);
    assert(strstr(json, "\"tx\":[-1,0,0,-1]") && strstr(json, "\"memHook\":-1"));
}

static void assert_tcp_diagnostics(const char *expected) {
    char json[QDD_WIFI_DIAGNOSTICS_MAX + 1];
    const unsigned sends = m.send_calls, reads = m.recv_calls;
    const uint32_t epoch = s_tcp_epoch;
    assert(qdd_wifi_diagnostics(json, sizeof(json)) > 0);
    assert(strstr(json, expected));
    assert(m.send_calls == sends && m.recv_calls == reads && s_tcp_epoch == epoch);
    assert(!strstr(json, "ack") && !strstr(json, "RRRR"));
}

static void test_tcp_diagnostics_cumulative_io_and_close(void) {
    connected();
    assert(sizeof(s_diag_tcp) == 32); // Fixed BSS only; no packet or acknowledgement buffer.
    assert_tcp_diagnostics("\"tcp\":[50,0,0,0,0,-1,-1,0,0]");
    uint8_t bytes[16];
    m.now_us = 100000; m.recv_result = 4;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 4);
    m.now_us = 110000;
    assert(qdd_wifi_write("ack", 3));
    m.now_us = 160000; m.recv_result = -1; m.recv_error = EAGAIN;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0 && qdd_wifi_tcp_live());
    assert_tcp_diagnostics("\"tcp\":[50,4,3,1,0,60,50,0,0]");

    m.now_us = 180000; m.send_result = 1; m.send_error = ECONNRESET;
    assert(!qdd_wifi_write("ack", 3)); // Positive short write has no errno.
    assert_tcp_diagnostics("\"tcp\":[51,4,4,1,1,80,0,0,5]");
    const unsigned sends = m.send_calls;
    assert(!qdd_wifi_write("ack", 3));
    assert(m.send_calls == sends); // Diagnostic counters do not introduce retries.
    assert(s_diag_tcp.tx_fail == 1 && s_diag_tcp.close_reason == TCP_CLOSE_SEND);

    m.next_accepted = 12; qdd_wifi_poll(180, false);
    assert(qdd_wifi_tcp_live() && s_tcp_epoch == 52);
    m.now_us = 200000; m.send_result = -2;
    assert(qdd_wifi_write("ack", 3));
    m.now_us = 210000; m.recv_result = 2;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 2);
    m.now_us = 220000;
    assert_tcp_diagnostics("\"tcp\":[52,6,7,2,1,10,20,0,5]");

    m.now_us = 230000; m.recv_result = -1; m.recv_error = ECONNRESET;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0 && !qdd_wifi_tcp_live());
    assert(s_diag_tcp.last_errno == ECONNRESET && s_diag_tcp.close_reason == TCP_CLOSE_RECV);
    m.next_accepted = 13; qdd_wifi_poll(230, false);
    assert(qdd_wifi_tcp_live() && s_tcp_epoch == 54);
    m.send_error = EAGAIN;
    assert(qdd_wifi_write("ack", 3)); // Successful send does not copy stale errno.
    m.recv_error = EAGAIN;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0);
    assert(s_diag_tcp.last_errno == ECONNRESET && s_diag_tcp.close_reason == TCP_CLOSE_RECV);
    qdd_wifi_close_client();
    assert(s_diag_tcp.close_reason == TCP_CLOSE_EXTERNAL && s_diag_tcp.last_errno == ECONNRESET);
    qdd_wifi_close_client();
    assert(s_tcp_epoch == 55 && s_diag_tcp.close_reason == TCP_CLOSE_EXTERNAL);
}

static void test_tcp_diagnostics_failure_reasons_and_bounds(void) {
    uint8_t bytes[16];
    connected();
    m.recv_result = 0;
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0);
    assert(s_diag_tcp.close_reason == TCP_CLOSE_EOF && !s_diag_tcp.rx_bytes);
    connected();
    event(NULL, IP_EVENT, IP_EVENT_STA_LOST_IP, NULL);
    assert(qdd_wifi_read(bytes, sizeof(bytes)) == 0);
    assert(s_diag_tcp.close_reason == TCP_CLOSE_NETWORK && m.recv_calls == 0);
    const ssize_t results[] = {0, 2, -1};
    for (size_t i = 0; i < sizeof(results) / sizeof(results[0]); i++) {
        connected();
        m.now_us = 900000; m.send_result = results[i]; m.send_error = EAGAIN;
        assert(!qdd_wifi_write("ack", 3));
        assert(s_diag_tcp.tx_ok == 0 && s_diag_tcp.tx_fail == 1);
        assert(s_diag_tcp.tx_bytes == (results[i] > 0 ? (unsigned)results[i] : 0));
        assert(s_diag_tcp.last_errno == (results[i] < 0 ? EAGAIN : 0));
        assert(s_diag_tcp.tx_ms == 900 && s_diag_tcp.close_reason == TCP_CLOSE_SEND);
        assert(m.send_calls == 1 && m.close_calls[11] == 1);
        m.now_us = 950000;
        assert_tcp_diagnostics(results[i] == 2 ? "\"tcp\":[51,0,2,0,1,-1,50,0,5]" :
            results[i] == 0 ? "\"tcp\":[51,0,0,0,1,-1,50,0,5]" : "\"tcp\":[51,0,0,0,1,-1,50,");
    }
}

int main(void) {
    test_idle_observer_replaced_by_valid_peer();
    test_observer_admission_protects_owner_fresh_and_invalid();
    test_observer_activity_is_per_client_and_rx_only();
    test_observer_zero_and_64bit_activity_boundaries();
    test_event_epoch_fail_closed();
    test_socket_io_failures();
    test_listener_and_single_peer();
    test_nvs_profile_isolation();
    test_stack_cleanup_and_scanning();
    test_scan_distinct_capacity_and_revision();
    test_scan_record_cleanup();
    test_requested_network_change_is_not_a_failure();
    test_failed_configuration_cannot_reconnect_old_profile();
    test_initial_retry_budget_and_recovery();
    test_immediate_failure_uses_short_retry();
    test_pending_configuration_and_stale_ip();
    test_diagnostics_without_started_wifi();
    test_diagnostics_numeric_callbacks_and_bounds();
    test_diagnostics_stale_cache_api_failures_and_maximum();
    test_tcp_diagnostics_cumulative_io_and_close();
    test_tcp_diagnostics_failure_reasons_and_bounds();
    assert(m.critical_depth == 0);
    puts("QDD actual Wi-Fi backend owner-free observer recovery, event epochs, socket faults, NVS isolation and cleanup tests: PASS");
    return 0;
}
