#include <assert.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

// Exercise the production HTTP handlers and lifecycle without any device,
// real network, NVS, Bluetooth report, HID or LVGL implementation.
#include "../main/qdd_onboarding.c"

const uint8_t qdd_test_apk[QDD_ONBOARDING_APK_SIZE] asm("_binary_qdd_remote_apk_start") = {0x50, 0x4b};
asm(".globl _binary_qdd_remote_apk_end\n.set _binary_qdd_remote_apk_end, _binary_qdd_remote_apk_start+3072");

static struct {
    uint64_t now, receive_delay;
    qdd_wifi_view_t wifi;
    qdd_ble_status_t ble;
    char peer[16], status[48], content_type[80], response[8192], hash[65];
    size_t response_size, receive_chunk;
    ssize_t content_length;
    const char *sent_body;
    unsigned critical_depth, starts, stops, route_count, chunks, yields, closes, sends, receives;
    unsigned tasks, nodelay_calls, http_sends, override_calls, native_sends;
    size_t native_limit, native_max, native_bytes;
    unsigned native_delay;
    bool native_zero, native_error;
    int native_errno;
    int8_t rssi;
    uint8_t channel;
    wifi_ps_type_t ps;
    size_t free_heap, largest_heap;
    bool fail_ap, fail_ps;
    unsigned ap_queries;
    httpd_send_func_t send_override;
    httpd_handle_t override_handle;
    int peer_family;
    bool native_ipv6, short_peer;
    int fail_route, fail_chunk;
    bool fail_start, fail_stop, fail_bind, fail_socket, fail_task, fail_recv, fail_peer, fail_send, register_on_stop;
    httpd_uri_t routes[5];
    const char *packet;
    unsigned packet_count;
    char udp_response[1024];
} m;

static void reset(void) {
    memset(&m, 0, sizeof(m));
    m.fail_route = -1;
    m.fail_chunk = -1;
    m.peer_family = AF_INET;
    strcpy(m.peer, "10.65.201.94");
    strcpy(m.wifi.ip, "10.65.201.147");
    m.wifi.connected = true;
    m.wifi.port = 3333;
    m.receive_chunk = 256;
    m.native_limit = 2048;
    m.rssi = -55;
    m.channel = 6;
    m.ps = WIFI_PS_NONE;
    m.free_heap = 40000;
    m.largest_heap = 22000;
    s_http = NULL;
    s_http_ready = false;
    s_udp = -1;
    s_ip[0] = 0;
    s_retry_at = 0;
    s_task = NULL;
    qdd_onboarding_model_clear(&s_model);
    atomic_store(&s_last_send_errno, 0);
    atomic_store(&s_last_send_error, 0);
    atomic_store(&s_last_download_result, 0);
    atomic_store(&s_last_download_ms, 0);
    atomic_store(&s_download_successes, 0);
    atomic_store(&s_download_failures, 0);
    atomic_flag_clear(&s_status_ap_busy);
}

void qdd_test_enter_critical(portMUX_TYPE *lock) { assert(lock == &s_lock); m.critical_depth++; }
void qdd_test_exit_critical(portMUX_TYPE *lock) { assert(lock == &s_lock && m.critical_depth); m.critical_depth--; }
void qdd_test_yield(void) { m.yields++; }
int64_t esp_timer_get_time(void) { return (int64_t)m.now * 1000; }
qdd_wifi_view_t qdd_wifi_view(void) { return m.wifi; }
qdd_ble_status_t qdd_ble_status(void) { return m.ble; }
const char *qdd_ble_name(void) { return "QDD-Passport-A1BA"; }
esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *record) {
    assert(record == &s_status_ap && !m.critical_depth);
    m.ap_queries++;
    if (m.fail_ap) return ESP_FAIL;
    record->rssi = m.rssi;
    record->primary = m.channel;
    return ESP_OK;
}
esp_err_t esp_wifi_get_ps(wifi_ps_type_t *mode) {
    assert(mode && !m.critical_depth);
    if (m.fail_ps) return ESP_FAIL;
    *mode = m.ps;
    return ESP_OK;
}
size_t heap_caps_get_free_size(uint32_t caps) {
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    return m.free_heap;
}
size_t heap_caps_get_largest_free_block(uint32_t caps) {
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    return m.largest_heap;
}
int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack, void *context,
    unsigned priority, TaskHandle_t *handle) {
    assert(entry == worker && strcmp(name, "qdd_onboard") == 0 && stack == 3072 && !context && priority == 1);
    m.tasks++;
    if (m.fail_task) return 0;
    *handle = (void *)1;
    return pdPASS;
}
void vTaskDelay(unsigned ticks) { assert(ticks == 100); }

esp_err_t httpd_start(httpd_handle_t *handle, const httpd_config_t *config) {
    assert(config->server_port == 3334 && config->max_open_sockets == 3 && config->max_uri_handlers == 5);
    assert(config->task_priority == 1 && config->stack_size == 4096 && config->lru_purge_enable);
    assert(config->recv_wait_timeout == 2 && config->send_wait_timeout == 2);
    m.starts++;
    m.route_count = 0;
    if (m.fail_start) return ESP_FAIL;
    *handle = (void *)2;
    return ESP_OK;
}
esp_err_t httpd_stop(httpd_handle_t handle) {
    assert(handle == (void *)2);
    m.stops++;
    if (m.fail_stop) return ESP_FAIL;
    if (m.register_on_stop) {
        assert(qdd_onboarding_model_pc(&s_model, "10.0.0.2", 8790, m.now));
    }
    return ESP_OK;
}
esp_err_t httpd_register_uri_handler(httpd_handle_t handle, const httpd_uri_t *uri) {
    assert(handle == (void *)2 && m.route_count < 5);
    if (m.fail_route == (int)m.route_count) return ESP_FAIL;
    m.routes[m.route_count++] = *uri;
    return ESP_OK;
}
int httpd_req_to_sockfd(httpd_req_t *request) { assert(request); return 9; }
esp_err_t httpd_sess_set_send_override(httpd_handle_t handle, int descriptor, httpd_send_func_t callback) {
    assert(descriptor == 9 && callback == bounded_send);
    m.override_calls++;
    m.send_override = callback;
    m.override_handle = handle;
    return ESP_OK;
}
esp_err_t httpd_resp_set_status(httpd_req_t *request, const char *status) {
    assert(request); strcpy(m.status, status); return ESP_OK;
}
esp_err_t httpd_resp_set_type(httpd_req_t *request, const char *type) {
    assert(request); strcpy(m.content_type, type); return ESP_OK;
}
esp_err_t httpd_resp_set_hdr(httpd_req_t *request, const char *key, const char *value) {
    assert(request && key && value);
    if (strcmp(key, "X-QDD-APK-SHA256") == 0) strcpy(m.hash, value);
    return ESP_OK;
}
esp_err_t httpd_resp_send(httpd_req_t *request, const char *body, ssize_t length) {
    assert(request);
    m.http_sends++;
    m.content_length = length;
    m.sent_body = body;
    if (m.fail_send) return ESP_FAIL;
    const size_t size = length == HTTPD_RESP_USE_STRLEN ? strlen(body) : (size_t)length;
    assert(size < sizeof(m.response));
    if (m.send_override) {
        size_t position = 0;
        while (position < size) {
            const int written = m.send_override(m.override_handle, 9, body + position, size - position, 0);
            if (written < 0) return ESP_ERR_HTTPD_RESP_SEND;
            assert(written > 0 && (size_t)written <= size - position);
            position += (size_t)written;
        }
    }
    memcpy(m.response, body, size);
    m.response[size] = 0;
    m.response_size = size;
    return ESP_OK;
}
esp_err_t httpd_resp_send_chunk(httpd_req_t *request, const char *body, ssize_t length) {
    assert(request && length >= 0);
    if (m.fail_chunk == (int)m.chunks++) return ESP_FAIL;
    assert(m.response_size + (size_t)length < sizeof(m.response));
    if (length) memcpy(m.response + m.response_size, body, (size_t)length);
    m.response_size += (size_t)length;
    m.response[m.response_size] = 0;
    return ESP_OK;
}
static const char *header(httpd_req_t *request, const char *key) {
    return strcmp(key, "Content-Type") == 0 ? request->content_type : request->origin;
}
size_t httpd_req_get_hdr_value_len(httpd_req_t *request, const char *key) {
    const char *value = header(request, key);
    return value ? strlen(value) : 0;
}
esp_err_t httpd_req_get_hdr_value_str(httpd_req_t *request, const char *key, char *value, size_t size) {
    const char *source = header(request, key);
    if (!source || strlen(source) >= size) return ESP_FAIL;
    strcpy(value, source);
    return ESP_OK;
}
int httpd_req_recv(httpd_req_t *request, char *body, size_t size) {
    m.now += m.receive_delay;
    if (m.fail_recv) return -1;
    if (size > m.receive_chunk) size = m.receive_chunk;
    assert(request->received + size <= request->content_len);
    memcpy(body, request->body + request->received, size);
    request->received += size;
    return (int)size;
}

int qdd_test_socket(int domain, int type, int protocol) {
    assert(domain == AF_INET && type == SOCK_DGRAM && protocol == IPPROTO_UDP);
    return m.fail_socket ? -1 : 7;
}
int qdd_test_close(int descriptor) { assert(descriptor == 7); m.closes++; return 0; }
int qdd_test_bind(int descriptor, const struct sockaddr *address, socklen_t size) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)address;
    assert(descriptor == 7 && size == sizeof(*in) && in->sin_family == AF_INET && in->sin_port == 3335);
    return m.fail_bind ? -1 : 0;
}
static void mock_ipv4(void *address) {
    unsigned octets[4];
    assert(sscanf(m.peer, "%u.%u.%u.%u", &octets[0], &octets[1], &octets[2], &octets[3]) == 4);
    uint8_t *bytes = address;
    for (unsigned i = 0; i < 4; i++) bytes[i] = (uint8_t)octets[i];
}
int qdd_test_getpeername(int descriptor, struct sockaddr *address, socklen_t *size) {
    assert(descriptor == 9 && *size == sizeof(struct sockaddr_storage));
    if (m.fail_peer) return -1;
    if (m.peer_family == AF_INET6) {
        struct sockaddr_in6 *peer = (struct sockaddr_in6 *)address;
        peer->sin6_family = AF_INET6;
        if (m.native_ipv6) peer->sin6_addr.bytes[0] = 0xfd;
        else peer->sin6_addr.bytes[10] = peer->sin6_addr.bytes[11] = 0xff;
        mock_ipv4(peer->sin6_addr.bytes + 12);
        *size = sizeof(*peer);
    } else {
        struct sockaddr_in *peer = (struct sockaddr_in *)address;
        peer->sin_family = (uint16_t)m.peer_family;
        mock_ipv4(&peer->sin_addr);
        *size = sizeof(*peer);
    }
    if (m.short_peer) *size = 2;
    return 0;
}
int qdd_test_setsockopt(int descriptor, int level, int option, const void *value, socklen_t size) {
    assert(descriptor == 9 && level == IPPROTO_TCP && option == TCP_NODELAY);
    assert(value && size == sizeof(int) && *(const int *)value == 1);
    m.nodelay_calls++;
    return 0;
}
ssize_t qdd_test_send(int descriptor, const void *bytes, size_t size, int flags) {
    assert(descriptor == 9 && bytes && size > 0 && size <= 2048 && flags == 0);
    m.native_sends++;
    m.now += m.native_delay;
    if (size > m.native_max) m.native_max = size;
    if (m.native_zero) return 0;
    if (m.native_error) { errno = m.native_errno; return -1; }
    if (size > m.native_limit) size = m.native_limit;
    m.native_bytes += size;
    return (ssize_t)size;
}
ssize_t qdd_test_recvfrom(int descriptor, void *bytes, size_t size, int flags,
    struct sockaddr *address, socklen_t *address_size) {
    assert(descriptor == 7 && flags == 0 && *address_size == sizeof(struct sockaddr_in));
    m.receives++;
    if (!m.packet_count) { errno = EAGAIN; return -1; }
    m.packet_count--;
    size_t length = strlen(m.packet);
    if (length > size) length = size;
    memcpy(bytes, m.packet, length);
    ((struct sockaddr_in *)address)->sin_family = AF_INET;
    mock_ipv4(&((struct sockaddr_in *)address)->sin_addr);
    return (ssize_t)length;
}
ssize_t qdd_test_sendto(int descriptor, const void *bytes, size_t size, int flags,
    const struct sockaddr *address, socklen_t address_size) {
    assert(descriptor == 7 && flags == 0 && address && address_size == sizeof(struct sockaddr_in));
    assert(size < sizeof(m.udp_response));
    memcpy(m.udp_response, bytes, size);
    m.udp_response[size] = 0;
    m.sends++;
    return (ssize_t)size;
}
uint16_t qdd_test_htons(uint16_t value) { return value; }
uint32_t qdd_test_htonl(uint32_t value) { return value; }
const char *qdd_test_inet_ntop(int family, const void *source, char *dest, socklen_t size) {
    assert(family == AF_INET && source && size >= 16);
    const uint8_t *bytes = source;
    snprintf(dest, size, "%u.%u.%u.%u", bytes[0], bytes[1], bytes[2], bytes[3]);
    return dest;
}
int qdd_test_fcntl(int descriptor, int command, ...) {
    assert(descriptor == 7 && (command == F_GETFL || command == F_SETFL));
    return 0;
}

static httpd_req_t registration(const char *body, bool phone) {
    return (httpd_req_t){.content_len = strlen(body), .body = body,
        .content_type = "application/json; charset=utf-8", .user_ctx = phone ? (void *)1 : NULL};
}

static void test_handlers(void) {
    reset();
    assert(start_http() == ESP_OK && m.route_count == 5);
    assert(strcmp(m.routes[0].uri, "/") == 0 && strcmp(m.routes[1].uri, "/qdd-remote.apk") == 0);
    assert(m.routes[3].user_ctx && !m.routes[4].user_ctx);
    httpd_req_t request = {0};
    assert(page_handler(&request) == ESP_OK);
    assert(m.nodelay_calls == 1 && m.override_calls == 1);
    assert(m.http_sends == 1 && m.chunks == 0 && m.content_length > 0);
    assert((size_t)m.content_length == m.response_size);
    assert(strstr(m.response, "class=\"tip\"") && strstr(m.response, "仅支持同一局域网"));
    assert(strstr(m.response, "手机、电脑和 ESP 必须连接同一局域网"));
    assert(strstr(m.response, "手机浏览器") && strstr(m.response, "IP:3334"));
    assert(strstr(m.response, "qddscreen://setup?esp=http%3A%2F%2F10.65.201.147%3A3334"));
    assert(strstr(m.response, "http://127.0.0.1:8790") && !strstr(m.response, "http://10.65.201.147:8790"));
    assert(!qdd_onboarding_view().downloaded);
    assert(status_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
    assert(m.nodelay_calls == 2);
    assert(strstr(m.response, "\"service\":\"qdd-esp-onboarding\"") && strstr(m.response, "\"tcpPort\":3333"));
    assert(strstr(m.response, "\"boardUrl\":\"http://10.65.201.147:3334\"") && m.response_size < 1024);
    m.ble.connected = m.ble.encrypted = m.ble.authenticated = m.ble.bonded = m.ble.ready = true;
    assert(status_handler(&request) == ESP_OK && strstr(m.response, "\"ready\":true"));
    request = registration("{\"port\":8790}", false);
    request.origin = "http://10.65.201.147:3334";
    m.receive_chunk = 3;
    assert(registration_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
    assert(m.nodelay_calls == 4);
    assert(qdd_onboarding_view().pc_fresh && strcmp(qdd_onboarding_view().pc_ip, m.peer) == 0);
    request = registration("{\"deviceId\":\"28c16ea2-c6ee-4b5d-8307-29b20df14bab\",\"port\":8791,\"projecting\":true}", true);
    assert(registration_handler(&request) == ESP_OK && qdd_onboarding_view().phone_projecting);
    m.now = 15000;
    assert(qdd_onboarding_view().phone_seen && !qdd_onboarding_view().phone_fresh);
    assert(m.critical_depth == 0);
}

static void test_registration_rejections(void) {
    reset();
    httpd_req_t request = registration("{\"port\":8790,\"ip\":\"10.0.0.2\"}", false);
    assert(registration_handler(&request) == ESP_OK && strcmp(m.status, "400 Bad Request") == 0);
    assert(!qdd_onboarding_view().pc_fresh);
    request = registration("{\"port\":8790}", false);
    request.origin = "https://other.example";
    assert(registration_handler(&request) == ESP_FAIL && strcmp(m.status, "415 Unsupported Media Type") == 0);
    request.origin = NULL;
    request.content_type = "text/plain";
    assert(registration_handler(&request) == ESP_FAIL);
    request.content_type = "application/json";
    request.content_len = 257;
    assert(registration_handler(&request) == ESP_FAIL && strcmp(m.status, "413 Content Too Large") == 0);
    request.content_len = 0;
    assert(registration_handler(&request) == ESP_FAIL);
    request = registration("{\"port\":8790}", false);
    strcpy(m.peer, "8.8.8.8");
    assert(registration_handler(&request) == ESP_FAIL && strcmp(m.status, "403 Forbidden") == 0);
    assert(status_handler(&request) == ESP_FAIL);
    strcpy(m.peer, "10.0.0.1");
    m.fail_recv = true;
    assert(registration_handler(&request) == ESP_FAIL);
    m.fail_recv = false;
    m.receive_chunk = 1;
    m.receive_delay = 1000;
    assert(registration_handler(&request) == ESP_FAIL && request.received == 2);
    assert(!qdd_onboarding_view().pc_fresh);
}

static void test_apk(void) {
    reset();
    httpd_req_t request = {0};
    m.fail_send = true;
    assert(apk_handler(&request) == ESP_FAIL && !qdd_onboarding_view().downloaded);
    assert(m.http_sends == 1 && m.content_length == QDD_ONBOARDING_APK_SIZE);
    assert(m.sent_body == (const char *)qdd_apk_start && m.response_size == 0);
    m.fail_send = false;
    assert(apk_handler(&request) == ESP_OK && qdd_onboarding_view().downloaded);
    assert(m.nodelay_calls == 2);
    assert(m.http_sends == 2 && m.content_length == QDD_ONBOARDING_APK_SIZE);
    assert(m.sent_body == (const char *)qdd_apk_start && m.chunks == 0 && m.yields == 0);
    assert(m.response_size == QDD_ONBOARDING_APK_SIZE && m.response[0] == 'P' && m.response[1] == 'K');
    assert(memcmp(m.response, qdd_test_apk, QDD_ONBOARDING_APK_SIZE) == 0);
    assert(strcmp(m.hash, QDD_ONBOARDING_APK_SHA256) == 0);
}

static void test_dual_stack_peer(void) {
    reset();
    m.peer_family = AF_INET6;
    httpd_req_t request = {0};
    // The real ESP-IDF listener uses IPv6 sockets, including for IPv4 QR URLs.
    assert(page_handler(&request) == ESP_OK && strstr(m.response, "下载设备投屏"));
    m.response_size = 0;
    assert(apk_handler(&request) == ESP_OK && m.response_size == QDD_ONBOARDING_APK_SIZE);
    assert(qdd_onboarding_view().downloaded);
    assert(status_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
    request = registration("{\"port\":8790}", false);
    assert(registration_handler(&request) == ESP_OK && qdd_onboarding_view().pc_fresh);
    assert(m.nodelay_calls == 4); // Mapped IPv4 peers also receive TCP_NODELAY.
    assert(strcmp(qdd_onboarding_view().pc_ip, "10.65.201.94") == 0);
    strcpy(m.peer, "8.8.8.8");
    assert(page_handler(&request) == ESP_FAIL && strcmp(m.status, "403 Forbidden") == 0);
    strcpy(m.peer, "192.168.1.2");
    m.short_peer = true;
    assert(status_handler(&request) == ESP_FAIL);
    m.short_peer = false;
    m.native_ipv6 = true;
    assert(status_handler(&request) == ESP_FAIL);
    m.native_ipv6 = false;
    m.peer_family = 99;
    assert(status_handler(&request) == ESP_FAIL);
    m.peer_family = AF_INET;
    m.fail_peer = true;
    assert(status_handler(&request) == ESP_FAIL);
    assert(m.nodelay_calls == 4); // Rejected peers never reach socket tuning.
    assert(m.override_calls == 4);
}

static void test_bounded_socket_send_and_diagnostics(void) {
    reset();
    httpd_req_t request = {.handle = (void *)2};
    m.native_limit = 17; // Real partial positive writes must advance send_all.
    m.native_delay = 1;
    assert(apk_handler(&request) == ESP_OK);
    assert(m.override_handle == request.handle && m.native_max == 2048);
    assert(m.native_sends > QDD_ONBOARDING_APK_SIZE / 17 && m.native_bytes == QDD_ONBOARDING_APK_SIZE);
    assert(memcmp(m.response, qdd_test_apk, QDD_ONBOARDING_APK_SIZE) == 0);
    assert(atomic_load(&s_download_successes) == 1 && atomic_load(&s_download_failures) == 0);
    assert(atomic_load(&s_last_download_result) == ESP_OK);
    assert(atomic_load(&s_last_download_ms) == m.native_sends);
    assert(atomic_load(&s_last_send_error) == 0 && atomic_load(&s_last_send_errno) == 0);

    reset();
    m.native_zero = true;
    assert(apk_handler(&request) == ESP_ERR_HTTPD_RESP_SEND);
    assert(m.native_sends == 1 && !qdd_onboarding_view().downloaded); // Zero cannot spin send_all.
    assert(atomic_load(&s_last_send_error) == HTTPD_SOCK_ERR_FAIL && atomic_load(&s_last_send_errno) == 0);
    assert(atomic_load(&s_download_successes) == 0 && atomic_load(&s_download_failures) == 1);

    reset();
    m.native_error = true;
    m.native_errno = EAGAIN;
    assert(apk_handler(&request) == ESP_ERR_HTTPD_RESP_SEND);
    assert(m.native_sends == 1 && !qdd_onboarding_view().downloaded);
    assert(atomic_load(&s_last_send_error) == -1 && atomic_load(&s_last_send_errno) == EAGAIN);
    assert(atomic_load(&s_last_download_result) == ESP_ERR_HTTPD_RESP_SEND);
    m.native_error = false;
    assert(status_handler(&request) == ESP_OK);
    assert(strstr(m.response, "\"lastSendError\":-1") && strstr(m.response, "\"downloadFailures\":1"));
    assert(strstr(m.response, "\"downloadSuccesses\":0") && strstr(m.response, "\"lastDownloadMs\":0"));

    // Keep the existing 1 KiB status buffer even at maximal diagnostic values.
    strcpy(m.wifi.ip, "192.168.255.253");
    m.wifi.port = 65535;
    qdd_onboarding_phone_t phone = {.device_id = "28c16ea2-c6ee-4b5d-8307-29b20df14bab", .port = 65535, .projecting = true};
    assert(qdd_onboarding_model_phone(&s_model, "192.168.255.254", &phone, m.now));
    assert(qdd_onboarding_model_pc(&s_model, "192.168.255.252", 65535, m.now));
    atomic_store(&s_last_send_errno, INT_MIN);
    atomic_store(&s_last_send_error, INT_MIN);
    atomic_store(&s_last_download_result, INT_MIN);
    atomic_store(&s_last_download_ms, UINT_MAX);
    atomic_store(&s_download_successes, UINT_MAX);
    atomic_store(&s_download_failures, UINT_MAX);
    m.rssi = -127;
    m.channel = UINT8_MAX;
    m.free_heap = m.largest_heap = UINT_MAX;
    char body[1024];
    const size_t size = status_json(body, sizeof(body));
    assert(size > 0 && size < sizeof(body) && strlen(body) == size);
}

static void test_wifi_memory_diagnostics(void) {
    reset();
    httpd_req_t request = {0};
    assert(status_handler(&request) == ESP_OK);
    assert(strstr(m.response, "\"rssi\":-55") && strstr(m.response, "\"channel\":6"));
    assert(strstr(m.response, "\"ps\":0") && strstr(m.response, "\"heap\":40000") && strstr(m.response, "\"largest\":22000"));
    m.fail_ap = m.fail_ps = true;
    assert(status_handler(&request) == ESP_OK);
    assert(strstr(m.response, "\"rssi\":-127") && strstr(m.response, "\"channel\":0") && strstr(m.response, "\"ps\":-1"));
    m.fail_ap = m.fail_ps = false;
    const unsigned before = m.ap_queries;
    assert(!atomic_flag_test_and_set(&s_status_ap_busy));
    assert(status_handler(&request) == ESP_OK && m.ap_queries == before);
    assert(strstr(m.response, "\"rssi\":-127") && strstr(m.response, "\"channel\":0"));
    atomic_flag_clear(&s_status_ap_busy);
}

static void test_udp_and_lifecycle(void) {
    reset();
    m.fail_start = true;
    poll_network(0);
    assert(m.starts == 1 && !s_http && s_udp == 7);
    poll_network(4999);
    assert(m.starts == 1);
    m.fail_start = false;
    poll_network(5000);
    assert(m.starts == 2 && s_http && m.route_count == 5);
    m.packet = "QDD-DISCOVER/1\r\n";
    m.packet_count = 3;
    const unsigned before = m.receives;
    poll_udp();
    assert(m.sends == 2 && m.receives - before == 2 && m.packet_count == 1);
    assert(strstr(m.udp_response, "\"service\":\"qdd-esp-onboarding\""));
    m.packet = "QDD-DISCOVER/1 ";
    m.packet_count = 1;
    poll_udp();
    assert(m.sends == 2);
    m.packet = "QDD-DISCOVER/1";
    m.packet_count = 1;
    strcpy(m.peer, "8.8.8.8");
    poll_udp();
    assert(m.sends == 2);
    qdd_onboarding_phone_t phone = {.device_id = "28c16ea2-c6ee-4b5d-8307-29b20df14bab", .port = 8791, .projecting = true};
    assert(qdd_onboarding_model_phone(&s_model, "10.0.0.2", &phone, m.now));
    s_model.view.downloaded = true;
    m.register_on_stop = true;
    m.wifi.connected = false;
    m.fail_stop = true;
    poll_network(6000);
    assert(s_http && s_udp == -1 && m.stops == 1 && m.closes == 1);
    m.fail_stop = false;
    poll_network(6000);
    assert(!s_http && s_udp == -1 && m.stops == 2 && m.closes == 1);
    assert(!qdd_onboarding_view().pc_fresh && !s_model.pc_registered);
    qdd_onboarding_view_t stopped = qdd_onboarding_view();
    assert(stopped.downloaded && stopped.phone_seen && !stopped.phone_fresh && !stopped.phone_projecting);
    assert(!stopped.phone_ip[0] && !stopped.phone_device_id[0] && !stopped.phone_port && !stopped.pc_ip[0] && !stopped.pc_port);
    m.wifi.connected = true;
    strcpy(m.wifi.ip, "192.168.1.147");
    poll_network(6100);
    assert(s_http && s_udp == 7 && strcmp(s_ip, "192.168.1.147") == 0);
    assert(qdd_onboarding_view().downloaded && qdd_onboarding_view().phone_seen);
    assert(!qdd_onboarding_view().phone_fresh && !qdd_onboarding_view().pc_fresh);
    reset();
    m.fail_route = 2;
    assert(start_http() == ESP_FAIL && !s_http && m.stops == 1);
    m.fail_stop = true;
    assert(start_http() == ESP_FAIL && s_http && !s_http_ready);
    const unsigned starts_before_retry = m.starts;
    assert(start_http() == ESP_FAIL && m.starts == starts_before_retry && s_http);
    m.fail_stop = false;
    m.fail_route = -1;
    assert(start_http() == ESP_OK && s_http_ready);
    m.fail_bind = true;
    assert(start_udp() == -1 && m.closes == 1);
    m.fail_socket = true;
    assert(start_udp() == -1 && m.closes == 1);
    m.fail_task = true;
    assert(qdd_onboarding_start() == ESP_ERR_NO_MEM && !s_task);
    m.fail_task = false;
    assert(qdd_onboarding_start() == ESP_OK && s_task);
    assert(qdd_onboarding_start() == ESP_OK && m.tasks == 2);
}

int main(void) {
    test_handlers();
    test_registration_rejections();
    test_apk();
    test_dual_stack_peer();
    test_bounded_socket_send_and_diagnostics();
    test_wifi_memory_diagnostics();
    test_udp_and_lifecycle();
    puts("QDD onboarding production handlers, APK download, UDP discovery and lifecycle tests: PASS");
    return 0;
}
