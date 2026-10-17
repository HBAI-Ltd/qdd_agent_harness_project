#include <assert.h>
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
    unsigned critical_depth, starts, stops, route_count, chunks, yields, closes, sends, receives;
    unsigned tasks;
    int fail_route, fail_chunk;
    bool fail_start, fail_stop, fail_bind, fail_socket, fail_task, fail_recv, fail_peer, register_on_stop;
    httpd_uri_t routes[5];
    const char *packet;
    unsigned packet_count;
    char udp_response[1024];
} m;

static void reset(void) {
    memset(&m, 0, sizeof(m));
    m.fail_route = -1;
    m.fail_chunk = -1;
    strcpy(m.peer, "10.65.201.94");
    strcpy(m.wifi.ip, "10.65.201.147");
    m.wifi.connected = true;
    m.wifi.port = 3333;
    m.receive_chunk = 256;
    s_http = NULL;
    s_http_ready = false;
    s_udp = -1;
    s_ip[0] = 0;
    s_retry_at = 0;
    s_task = NULL;
    qdd_onboarding_model_clear(&s_model);
}

void qdd_test_enter_critical(portMUX_TYPE *lock) { assert(lock == &s_lock); m.critical_depth++; }
void qdd_test_exit_critical(portMUX_TYPE *lock) { assert(lock == &s_lock && m.critical_depth); m.critical_depth--; }
void qdd_test_yield(void) { m.yields++; }
int64_t esp_timer_get_time(void) { return (int64_t)m.now * 1000; }
qdd_wifi_view_t qdd_wifi_view(void) { return m.wifi; }
qdd_ble_status_t qdd_ble_status(void) { return m.ble; }
const char *qdd_ble_name(void) { return "QDD-Passport-A1BA"; }
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
    const size_t size = length == HTTPD_RESP_USE_STRLEN ? strlen(body) : (size_t)length;
    assert(size < sizeof(m.response));
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
int qdd_test_getpeername(int descriptor, struct sockaddr *address, socklen_t *size) {
    assert(descriptor == 9 && *size == sizeof(struct sockaddr_in));
    if (m.fail_peer) return -1;
    ((struct sockaddr_in *)address)->sin_family = AF_INET;
    return 0;
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
    assert(family == AF_INET && source && strlen(m.peer) < size);
    strcpy(dest, m.peer);
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
    assert(strstr(m.response, "class=\"tip\"") && strstr(m.response, "仅支持同一局域网"));
    assert(strstr(m.response, "手机、电脑和 ESP 必须连接同一局域网"));
    assert(strstr(m.response, "手机浏览器") && strstr(m.response, "IP:3334"));
    assert(strstr(m.response, "qddscreen://setup?esp=http%3A%2F%2F10.65.201.147%3A3334"));
    assert(strstr(m.response, "http://127.0.0.1:8790") && !strstr(m.response, "http://10.65.201.147:8790"));
    assert(!qdd_onboarding_view().downloaded);
    assert(status_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
    assert(strstr(m.response, "\"service\":\"qdd-esp-onboarding\"") && strstr(m.response, "\"tcpPort\":3333"));
    assert(strstr(m.response, "\"boardUrl\":\"http://10.65.201.147:3334\"") && m.response_size < 1024);
    m.ble.connected = m.ble.encrypted = m.ble.authenticated = m.ble.bonded = m.ble.ready = true;
    assert(status_handler(&request) == ESP_OK && strstr(m.response, "\"ready\":true"));
    request = registration("{\"port\":8790}", false);
    request.origin = "http://10.65.201.147:3334";
    m.receive_chunk = 3;
    assert(registration_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
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
    m.fail_chunk = 1;
    assert(apk_handler(&request) == ESP_FAIL && !qdd_onboarding_view().downloaded);
    m.fail_chunk = -1;
    m.chunks = 0;
    m.response_size = 0;
    assert(apk_handler(&request) == ESP_OK && qdd_onboarding_view().downloaded);
    assert(m.response_size == QDD_ONBOARDING_APK_SIZE && m.chunks == 4 && m.response[0] == 'P' && m.response[1] == 'K');
    assert(strcmp(m.hash, QDD_ONBOARDING_APK_SHA256) == 0 && m.yields == 4);
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
    m.register_on_stop = true;
    m.wifi.connected = false;
    m.fail_stop = true;
    poll_network(6000);
    assert(s_http && s_udp == -1 && m.stops == 1 && m.closes == 1);
    m.fail_stop = false;
    poll_network(6000);
    assert(!s_http && s_udp == -1 && m.stops == 2 && m.closes == 1);
    assert(!qdd_onboarding_view().pc_fresh && !s_model.pc_registered);
    m.wifi.connected = true;
    strcpy(m.wifi.ip, "192.168.1.147");
    poll_network(6100);
    assert(s_http && s_udp == 7 && strcmp(s_ip, "192.168.1.147") == 0);
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
    test_udp_and_lifecycle();
    puts("QDD onboarding production handlers, APK download, UDP discovery and lifecycle tests: PASS");
    return 0;
}
