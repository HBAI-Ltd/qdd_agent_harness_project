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
const uint8_t qdd_test_driver_js[31] asm("_binary_qdd_driver_download_js_start") = {
    0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 2, 10, 0xd3, 0xd7, 0x57, 0x28, 0x49, 0x2d,
    0x2e, 0x51, 0xc8, 0x2a, 0xe6, 2, 0, 0xa8, 0xf7, 0x81, 0x33, 11, 0, 0, 0
};
asm(".globl _binary_qdd_driver_download_js_end\n.set _binary_qdd_driver_download_js_end, _binary_qdd_driver_download_js_start+31");
const uint8_t qdd_test_usb_installer[QDD_USB_INSTALLER_GZIP_SIZE] asm("_binary_qdd_usb_installer_exe_start") = {
    0x1f,0x8b,0x08,0x00,0x00,0x00,0x00,0x00,0x02,0x0a,0xf3,0x8d,0x62,0x20,0x1b,0x38,
    0x00,0x71,0x80,0x2b,0x03,0x43,0x4a,0x1b,0xf9,0x66,0x00,0x00,0xdf,0xb4,0x59,0x34,
    0x80,0x00,0x00,0x00
};
asm(".globl _binary_qdd_usb_installer_exe_end\n.set _binary_qdd_usb_installer_exe_end, _binary_qdd_usb_installer_exe_start+36");
const uint8_t qdd_test_usb_receiver[QDD_USB_RECEIVER_GZIP_SIZE] asm("_binary_qdd_usb_receiver_html_start") = {
    0x1f,0x8b,0x08,0x00,0x00,0x00,0x00,0x00,0x02,0x0a,0xb3,0x51,0x4c,0xc9,0x4f,0x2e,0xa9,0x2c,0x48,0x55,
    0xc8,0x28,0xc9,0xcd,0xb1,0xb3,0x81,0x90,0x49,0xf9,0x29,0x95,0x76,0xfe,0x69,0x69,0x39,0x99,0x79,0xa9,
    0x0a,0xa1,0xc1,0x4e,0x36,0xc5,0xc9,0x45,0x99,0x05,0x25,0x76,0xc9,0xf9,0x79,0xc5,0x25,0x0a,0x05,0x45,
    0xf9,0x25,0xf9,0xc9,0xf9,0x39,0xb6,0x4a,0x81,0x2e,0x2e,0x2e,0x41,0x61,0xfa,0x86,0x4a,0xd6,0x36,0xfa,
    0x50,0x25,0x36,0xfa,0x60,0xcd,0x36,0xfa,0x60,0x93,0xb8,0x00,0xd9,0x03,0xb4,0x7a,0x60,0x00,0x00,0x00
};
asm(".globl _binary_qdd_usb_receiver_html_end\n.set _binary_qdd_usb_receiver_html_end, _binary_qdd_usb_receiver_html_start+100");
static uint8_t test_zip[5000];

static struct {
    uint64_t now, receive_delay;
    qdd_wifi_view_t wifi;
    qdd_ble_status_t ble;
    char peer[16], status[48], content_type[80], response[8192], hash[65], location[48], content_range[80], etag[68], csp[192], content_encoding[16], disposition[192];
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
    size_t pressure_free, pressure_largest;
    unsigned pressure_on_read, pressure_on_send, pressure_sends, headroom_delays;
    unsigned recover_after_delays, cancel_after_delays, stop_after_delays;
    bool pressure_active;
    bool fail_ap, fail_ps;
    unsigned ap_queries;
    httpd_send_func_t send_override;
    httpd_handle_t override_handle;
    int peer_family;
    bool native_ipv6, short_peer;
    int fail_route, fail_chunk;
    bool fail_start, fail_stop, fail_bind, fail_socket, fail_task, fail_recv, fail_peer, fail_send, register_on_stop;
    httpd_uri_t routes[12];
    bool asset_claimed, fail_asset_claim;
    unsigned asset_claims, asset_releases;
    bool fail_asset_open, fail_asset_read, zip_asset;
    char asset_hash_char;
    unsigned asset_opens, asset_reads;
    unsigned async_begins, async_completes, session_closes, deleted_tasks;
    bool fail_async_begin;
    void (*pending_task)(void *);
    void *pending_context;
    httpd_req_t async_request;
    size_t asset_next_offset, native_error_after;
    void *asset_staging;
    const char *packet;
    unsigned packet_count;
    char udp_response[1024];
} m;

static void reset(void) {
    memset(&m, 0, sizeof(m));
    for (size_t i = 0; i < sizeof(test_zip); i++) test_zip[i] = (uint8_t)((i * 37u + 11u) % 251u);
    memcpy(test_zip, "PK\003\004", 4);
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
    memset(&s_download_diag, 0, sizeof(s_download_diag));
    atomic_store(&s_last_send_errno, 0);
    atomic_store(&s_last_send_error, 0);
    atomic_store(&s_last_download_result, 0);
    atomic_store(&s_last_download_ms, 0);
    atomic_store(&s_download_successes, 0);
    atomic_store(&s_download_failures, 0);
    atomic_flag_clear(&s_status_ap_busy);
    atomic_store(&s_download_busy, false);
    atomic_store(&s_download_cancel, false);
    atomic_store(&s_download_stopping, false);
}

void qdd_test_enter_critical(portMUX_TYPE *lock) { assert(lock == &s_lock || lock == &s_download_diag_lock); m.critical_depth++; }
void qdd_test_exit_critical(portMUX_TYPE *lock) { assert((lock == &s_lock || lock == &s_download_diag_lock) && m.critical_depth); m.critical_depth--; }
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
    if (entry == download_worker) {
        assert(!strcmp(name, "qdd_download") && stack == 4096 && context && priority == 1 && !handle);
        if (m.fail_task) return 0;
        assert(!m.pending_task); m.pending_task = entry; m.pending_context = context;
        return pdPASS;
    }
    assert(entry == worker && strcmp(name, "qdd_onboard") == 0 && stack == 3072 && !context && priority == 1);
    m.tasks++;
    if (m.fail_task) return 0;
    *handle = (void *)1;
    return pdPASS;
}
void vTaskDelay(unsigned ticks) {
    assert(ticks == 10 || ticks == 100);
    m.now += ticks;
    if (!m.pressure_active || ticks != 10) return;
    // A stalled body must leave the network producer alone while other tasks
    // reclaim queued buffers; cancellation may arrive during that yield.
    assert(m.native_sends == m.pressure_sends && !m.critical_depth);
    m.headroom_delays++;
    if (m.cancel_after_delays == m.headroom_delays) atomic_store(&s_download_cancel, true);
    if (m.stop_after_delays == m.headroom_delays) atomic_store(&s_download_stopping, true);
    if (m.recover_after_delays == m.headroom_delays) {
        m.free_heap = 40000; m.largest_heap = 22000; m.pressure_active = false;
    }
}
void vTaskDelete(TaskHandle_t task) { assert(!task); m.deleted_tasks++; }

esp_err_t httpd_start(httpd_handle_t *handle, const httpd_config_t *config) {
    assert(config->server_port == 3334 && config->max_open_sockets == 3 && config->max_uri_handlers == 12);
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
    assert(handle == (void *)2 && m.route_count < 12);
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
    if (!strcmp(key, "X-QDD-APK-SHA256") || !strcmp(key, "X-QDD-EXE-SHA256") || !strcmp(key, "X-QDD-HTML-SHA256")) strcpy(m.hash, value);
    if (!strcmp(key, "Location")) strcpy(m.location, value);
    if (!strcmp(key, "Content-Range")) strcpy(m.content_range, value);
    if (!strcmp(key, "ETag")) strcpy(m.etag, value);
    if (!strcmp(key, "Content-Security-Policy")) strcpy(m.csp, value);
    if (!strcmp(key, "Content-Encoding")) strcpy(m.content_encoding, value);
    if (!strcmp(key, "Content-Disposition")) strcpy(m.disposition, value);
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
static const uint8_t test_exe[5000] = {'M', 'Z'};
static const esp_partition_t test_partition = {.size = 0x200000};
bool qdd_download_assets_claim(void) {
    m.asset_claims++;
    if (m.fail_asset_claim || m.asset_claimed) return false;
    m.asset_claimed = true;
    return true;
}
void qdd_download_assets_release(void) {
    assert(m.asset_claimed);
    m.asset_claimed = false;
    m.asset_releases++;
}
esp_err_t qdd_download_assets_open(qdd_download_asset_t *asset, bool (*cancelled)(void), void *staging, size_t capacity) {
    assert(staging && capacity == 2048); m.asset_staging = staging;
    m.asset_opens++;
    memset(asset, 0, sizeof(*asset));
    if (m.fail_asset_open || (cancelled && cancelled())) return ESP_FAIL;
    asset->partition = &test_partition; asset->size = sizeof(test_exe);
    asset->kind = m.zip_asset ? QDD_DOWNLOAD_ZIP : QDD_DOWNLOAD_EXE;
    memset(asset->sha256, m.asset_hash_char ? m.asset_hash_char : 'a', 64); asset->sha256[64] = 0;
    return ESP_OK;
}
esp_err_t qdd_download_assets_read(const qdd_download_asset_t *asset,
    size_t offset, void *buffer, size_t length) {
    assert(asset->partition == &test_partition && length > 0 && length <= 2048 && buffer == m.asset_staging);
    assert(offset == m.asset_next_offset && offset + length <= sizeof(test_exe));
    m.asset_reads++;
    if (m.fail_asset_read) return ESP_FAIL;
    if (m.pressure_on_read == m.asset_reads) {
        m.free_heap = m.pressure_free; m.largest_heap = m.pressure_largest;
        m.pressure_sends = m.native_sends; m.pressure_active = true;
    }
    memcpy(buffer, (m.zip_asset ? test_zip : test_exe) + offset, length); m.asset_next_offset += length;
    return ESP_OK;
}
int httpd_send(httpd_req_t *request, const char *body, size_t size) {
    assert(request && m.send_override);
    const int count = m.send_override(m.override_handle, 9, body, size, 0);
    if (count > 0) {
        assert(m.response_size + (size_t)count < sizeof(m.response));
        memcpy(m.response + m.response_size, body, (size_t)count);
        m.response_size += (size_t)count; m.response[m.response_size] = 0;
    }
    return count;
}

esp_err_t httpd_req_async_handler_begin(httpd_req_t *request, httpd_req_t **copy) {
    m.async_begins++;
    if (m.fail_async_begin) return ESP_FAIL;
    assert(atomic_load(&s_download_busy) && m.async_begins == m.async_completes + 1);
    m.async_request = *request; *copy = &m.async_request; return ESP_OK;
}
esp_err_t httpd_req_async_handler_complete(httpd_req_t *request) {
    assert(request == &m.async_request && atomic_load(&s_download_busy));
    m.async_completes++; assert(m.async_completes <= m.async_begins); return ESP_OK;
}
esp_err_t httpd_sess_trigger_close(httpd_handle_t server, int descriptor) {
    assert(server == (void *)2 && descriptor == 9); m.session_closes++; return ESP_OK;
}
static void run_pending_download(void) {
    assert(m.pending_task == download_worker);
    void (*task)(void *) = m.pending_task; void *context = m.pending_context;
    m.pending_task = NULL; m.pending_context = NULL; task(context);
}
static esp_err_t run_exe(httpd_req_t *request) {
    const esp_err_t result = exe_handler(request);
    if (m.pending_task) run_pending_download();
    return m.session_closes ? ESP_FAIL : result;
}

static const char *header(httpd_req_t *request, const char *key) {
    if (!strcmp(key, "User-Agent")) return request->user_agent;
    if (!strcmp(key, "Range")) return request->range;
    if (!strcmp(key, "If-Match")) return request->if_match;
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
    if (m.native_error || (m.native_error_after && m.native_bytes >= m.native_error_after)) { errno = m.native_errno; return -1; }
    if (size > m.native_limit) size = m.native_limit;
    m.native_bytes += size;
    if (m.pressure_on_send == m.native_sends) {
        m.free_heap = m.pressure_free; m.largest_heap = m.pressure_largest;
        m.pressure_sends = m.native_sends; m.pressure_active = true;
    }
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
    assert(start_http() == ESP_OK && m.route_count == 12);
    assert(strcmp(m.routes[0].uri, "/") == 0 && strcmp(m.routes[1].uri, "/qdd-remote.apk") == 0);
    assert(strcmp(m.routes[2].uri, "/qdd-desktop.exe") == 0);
    assert(!strcmp(m.routes[3].uri, "/qdd-desktop.zip") && m.routes[3].user_ctx);
    assert(!strcmp(m.routes[4].uri, "/driver-download.js") && m.routes[4].handler == driver_script_handler);
    assert(!strcmp(m.routes[5].uri, "/qdd-usb-installer.exe") && m.routes[5].handler == usb_installer_handler);
    assert(!strcmp(m.routes[6].uri, "/qdd-usb-receiver.html") && m.routes[6].handler == usb_receiver_handler && !m.routes[6].user_ctx);
    assert(!strcmp(m.routes[7].uri, "/usb-receiver") && m.routes[7].handler == usb_receiver_page_redirect && !m.routes[7].user_ctx);
    assert(!strcmp(m.routes[9].uri, "/api/download-status"));
    assert(m.routes[10].user_ctx && !m.routes[11].user_ctx);
    httpd_req_t request = {0};
    assert(page_handler(&request) == ESP_OK);
    assert(m.nodelay_calls == 1 && m.override_calls == 1);
    assert(m.http_sends == 1 && m.chunks == 0 && m.content_length > 0);
    assert((size_t)m.content_length == m.response_size);
    assert(strstr(m.response, "class=\"tip\"") && strstr(m.response, "页面已打开"));
    assert(strstr(m.response, "手机、电脑和设备连接同一个无线网即可"));
    assert(!strstr(m.response, "热点") && !strstr(m.response, "直连"));
    assert(!strstr(m.response, "USB") && !strstr(m.response, "/usb-receiver") && !strstr(m.response, "保存 HTML"));
    assert(strstr(m.response, "无需互联网"));
    assert(!strstr(m.response, "IP:3334") && !strstr(m.response, "<code>"));
    assert(strstr(m.response, "qddscreen://setup?esp=http%3A%2F%2F10.65.201.147%3A3334"));
    assert(!strstr(m.response, "http://127.0.0.1:8790") && !strstr(m.response, "http://10.65.201.147:8790"));
    assert(strstr(m.response, "<section id=\"install-step-1\"><h2>1. 连接无线网"));
    assert(strstr(m.response, "<section id=\"install-step-2\"><h2>2. 下载对应安装包"));
    assert(strstr(m.response, "<section id=\"install-step-3\"><h2>3. 安装并打开"));
    assert(!strstr(m.response, "install-step-2\" hidden") && !strstr(m.response, "install-step-3\" hidden"));
    assert(strstr(m.response, "id=\"install-navigation\"") && strstr(m.response, ">上一步</button>") && strstr(m.response, ">下一步</button>"));
    assert(!qdd_onboarding_view().downloaded);
    assert(strstr(m.response, "type=\"module\" src=\"/driver-download.js\""));
    assert(strstr(m.response, "driver-download-status\"") && strstr(m.response, "driver-download-cancel\""));
    assert(!strstr(m.response, "data-driver-download"));
    const char *resume_link = strstr(m.response, "data-driver-resume");
    assert(resume_link && !strstr(resume_link + 1, "data-driver-resume"));
    assert(strstr(m.response, "<details><summary>下载遇到问题</summary>"));
    assert(strstr(m.response, "重新下载并支持续传"));
    assert(strstr(m.csp, "script-src 'self'") && strstr(m.csp, "connect-src 'self'"));
    m.response_size = 0;
    assert(driver_script_handler(&request) == ESP_OK);
    assert(!strcmp(m.content_type, "application/javascript; charset=utf-8") && m.response_size == sizeof(qdd_test_driver_js));
    assert(!strcmp(m.content_encoding, "gzip") && m.content_length == sizeof(qdd_test_driver_js));
    assert(!memcmp(m.response, qdd_test_driver_js, sizeof(qdd_test_driver_js)) && !qdd_onboarding_view().downloaded);
    assert(status_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
    assert(m.nodelay_calls == 3);
    assert(strstr(m.response, "\"service\":\"qdd-esp-onboarding\"") && strstr(m.response, "\"tcpPort\":3333"));
    assert(strstr(m.response, "\"boardUrl\":\"http://10.65.201.147:3334\"") && m.response_size < 1024);
    m.ble.connected = m.ble.encrypted = m.ble.authenticated = m.ble.bonded = m.ble.ready = true;
    assert(status_handler(&request) == ESP_OK && strstr(m.response, "\"ready\":true"));
    request = registration("{\"port\":8790}", false);
    request.origin = "http://10.65.201.147:3334";
    m.receive_chunk = 3;
    assert(registration_handler(&request) == ESP_OK && strcmp(m.status, "200 OK") == 0);
    assert(m.nodelay_calls == 5);
    assert(qdd_onboarding_view().pc_fresh && strcmp(qdd_onboarding_view().pc_ip, m.peer) == 0);
    request = registration("{\"deviceId\":\"28c16ea2-c6ee-4b5d-8307-29b20df14bab\",\"port\":8791,\"projecting\":true}", true);
    assert(registration_handler(&request) == ESP_OK && qdd_onboarding_view().phone_projecting);
    m.now = 15000;
    assert(qdd_onboarding_view().phone_seen && !qdd_onboarding_view().phone_fresh);
    assert(m.critical_depth == 0);
}

static void test_platform_downloads(void) {
    reset();
    httpd_req_t request = {.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"};
    assert(page_handler(&request) == ESP_OK);
    assert(strstr(m.response, "id=\"recommended-download\" href=\"/qdd-desktop.zip\" download=\"设备操作台.zip\" data-install-platform=\"windows\">下载 Windows 电脑版"));
    assert(strstr(m.response, "data-platform=\"windows\"") && !strstr(m.response, "USB 极速下载"));
    assert(!strstr(m.response, "href=\"/usb-receiver\"") && !strstr(m.response, "USB 备用下载"));
    assert(!strstr(m.response, "href=\"/qdd-usb-installer.exe\"") && !strstr(m.response, "保存 HTML 到电脑"));
    assert(strstr(m.response, "class=\"secondary\" href=\"/qdd-remote.apk\" download=\"设备投屏.apk\" data-install-platform=\"android\""));
    assert(strstr(m.response, "href=\"/qdd-desktop.zip\" data-driver-resume>电脑：重新下载并支持续传</a>"));
    assert(strstr(m.response, "href=\"/qdd-remote.apk\"") && strstr(m.response, "href=\"/qdd-desktop.zip\""));
    assert(strstr(m.response, "全部解压缩") && !strstr(m.response, "download=\"设备操作台.exe\""));
    request.user_agent = "Mozilla/5.0 (Linux; Android 14; Tablet)";
    assert(page_handler(&request) == ESP_OK);
    assert(strstr(m.response, "id=\"recommended-download\" href=\"/qdd-remote.apk\""));
    request.user_agent = NULL;
    assert(page_handler(&request) == ESP_OK);
    assert(strstr(m.response, "id=\"recommended-download\" href=\"/qdd-remote.apk\""));
    char oversized[200]; memset(oversized, 'x', sizeof(oversized)); oversized[199] = 0;
    request.user_agent = oversized;
    assert(page_handler(&request) == ESP_OK);
    assert(strstr(m.response, "id=\"recommended-download\" href=\"/qdd-remote.apk\""));

    reset(); request = (httpd_req_t){.handle = (void *)2}; m.native_limit = 17;
    assert(run_exe(&request) == ESP_OK);
    const char *body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
    assert(strstr(m.response, "Content-Length: 5000\r\n"));
    assert(strstr(m.response, "Content-Type: application/vnd.microsoft.portable-executable\r\n"));
    assert(strstr(m.response, "Content-Disposition: attachment; filename=\"device-console.exe\""));
    assert(strstr(m.response, "X-QDD-EXE-SHA256: aaaaaaaa"));
    assert(m.response_size - (size_t)(body - m.response) == sizeof(test_exe));
    assert(!memcmp(body, test_exe, sizeof(test_exe)) && m.asset_reads == 3);
    assert(m.native_max <= 2048 && !qdd_onboarding_view().downloaded);
    assert(!atomic_load(&s_download_successes) && !atomic_load(&s_download_failures));

    reset(); m.fail_asset_open = true;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(strstr(m.response, "missing or corrupt") && m.asset_reads == 0);
    assert(!qdd_onboarding_view().downloaded);
    // A broken/missing desktop resource never blocks the embedded APK.
    assert(apk_handler(&request) == ESP_OK && qdd_onboarding_view().downloaded);
    reset(); m.fail_asset_read = true;
    assert(run_exe(&request) == ESP_FAIL && m.asset_reads == 1);
    assert(!qdd_onboarding_view().downloaded);
    reset(); m.native_zero = true;
    assert(run_exe(&request) == ESP_FAIL && m.asset_reads == 0);
    reset(); m.native_error = true; m.native_errno = EAGAIN;
    assert(run_exe(&request) == ESP_FAIL && m.asset_reads == 0);
    reset(); strcpy(m.peer, "8.8.8.8");
    assert(run_exe(&request) == ESP_FAIL && m.asset_opens == 0);
}

static void test_download_diagnostics(void) {
    reset(); httpd_req_t request = {.handle = (void *)2};
    assert(download_status_handler(&request) == ESP_OK && m.response_size < 256);
    assert(strstr(m.response, "\"busy\":false") && strstr(m.response, "\"sentBytes\":0"));
    assert(exe_handler(&request) == ESP_OK && s_download_diag.start_heap == 40000);
    assert(download_status_handler(&request) == ESP_OK && strstr(m.response, "\"busy\":true"));
    m.response_size = 0; m.free_heap = 20000; m.largest_heap = 9000;
    run_pending_download();
    assert(s_download_diag.sent_bytes == sizeof(test_exe));
    assert(s_download_diag.after_verify_heap == 20000 && s_download_diag.min_heap == 20000);
    assert(s_download_diag.min_largest == 9000 && s_download_diag.end_heap == 20000);
    assert(s_download_diag.result == ESP_OK && s_download_diag.socket_errno == 0 && s_download_diag.phase == 5);
    assert(download_status_handler(&request) == ESP_OK && strstr(m.response, "\"busy\":false"));
    assert(strstr(m.response, "\"sentBytes\":5000") && strstr(m.response, "\"endHeap\":20000"));

    reset(); m.native_limit = 17; m.native_error_after = 600; m.native_errno = EAGAIN;
    assert(run_exe(&request) == ESP_FAIL);
    const char *body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
    assert(s_download_diag.sent_bytes == m.response_size - (size_t)(body - m.response));
    assert(s_download_diag.sent_bytes > 0 && s_download_diag.sent_bytes < sizeof(test_exe));
    assert(s_download_diag.result == ESP_ERR_HTTPD_RESP_SEND && s_download_diag.socket_errno == EAGAIN);
    assert(m.async_completes == 1 && m.session_closes == 1 && !atomic_load(&s_download_busy));
    const unsigned bytes = s_download_diag.sent_bytes;
    m.native_error_after = 0;
    assert(download_status_handler(&request) == ESP_OK && s_download_diag.sent_bytes == bytes);
    assert(m.response_size < 256);

    reset(); m.fail_asset_open = true;
    assert(run_exe(&request) == ESP_OK && s_download_diag.result == ESP_FAIL);
    assert(s_download_diag.sent_bytes == 0 && s_download_diag.after_verify_heap == 40000 && s_download_diag.phase == 5);
    reset(); m.fail_async_begin = true;
    assert(exe_handler(&request) == ESP_OK && s_download_diag.result == ESP_FAIL && s_download_diag.phase == 5);
    reset(); m.fail_task = true;
    assert(exe_handler(&request) == ESP_OK && s_download_diag.result == ESP_ERR_NO_MEM && s_download_diag.phase == 5);

    char bounded[258]; memset(bounded, 'X', sizeof(bounded));
    const size_t size = qdd_onboarding_download_diagnostics(bounded + 1, 256);
    assert(size > 0 && size < 256 && bounded[0] == 'X' && bounded[size + 2] == 'X');
    assert(qdd_onboarding_download_diagnostics(bounded + 1, size + 1) == size);
    assert(!qdd_onboarding_download_diagnostics(bounded + 1, size) && bounded[1] == 0);
    assert(!qdd_onboarding_download_diagnostics(NULL, 256));
    assert(!qdd_onboarding_download_diagnostics(bounded, 0));
    reset(); s_download_diag = (download_diagnostics_t){.phase = UINT_MAX, .start_heap = UINT_MAX,
        .after_verify_heap = UINT_MAX, .min_heap = UINT_MAX, .min_largest = UINT_MAX,
        .end_heap = UINT_MAX, .sent_bytes = UINT_MAX, .result = INT_MIN, .socket_errno = INT_MIN};
    assert(download_status_handler(&request) == ESP_OK && m.response_size < 256);
    strcpy(m.peer, "8.8.8.8"); assert(download_status_handler(&request) == ESP_FAIL);
}

static void test_zip_download_and_legacy_redirect(void) {
    reset(); m.zip_asset = true; m.native_limit = 17;
    httpd_req_t request = {.handle = (void *)2, .user_ctx = (void *)1};
    assert(run_exe(&request) == ESP_OK);
    const char *body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
    assert(strstr(m.response, "Content-Type: application/zip\r\n"));
    assert(strstr(m.response, "Content-Length: 5000\r\n"));
    assert(strstr(m.response, "filename=\"device-console.zip\"") && strstr(m.response, ".zip\r\n"));
    assert(strstr(m.response, "X-QDD-ZIP-SHA256: aaaaaaaa") && !strstr(m.response, "X-QDD-EXE-SHA256"));
    assert(m.response_size - (size_t)(body - m.response) == sizeof(test_zip));
    assert(!memcmp(body, test_zip, sizeof(test_zip)) && m.asset_reads == 3 && m.native_max <= 2048);
    assert(s_download_diag.sent_bytes == sizeof(test_zip) && !qdd_onboarding_view().downloaded);
    assert(!atomic_load(&s_download_busy) && m.async_begins == 1 && m.async_completes == 1 && m.deleted_tasks == 1);

    reset(); m.zip_asset = true; request.user_ctx = NULL;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "307 Temporary Redirect"));
    assert(!strcmp(m.location, "/qdd-desktop.zip") && m.asset_reads == 0);
    assert(s_download_diag.sent_bytes == 0 && !atomic_load(&s_download_busy) && m.async_completes == 1);
    assert(!qdd_onboarding_view().downloaded && !strstr(m.response, "Content-Type: application/vnd.microsoft"));

    reset(); request.user_ctx = (void *)1;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(strstr(m.response, "/qdd-desktop.exe") && m.asset_reads == 0 && !qdd_onboarding_view().downloaded);

    reset(); m.zip_asset = true;
    assert(exe_handler(&request) == ESP_OK && m.pending_task);
    assert(exe_handler(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable") && m.async_begins == 1);
    httpd_req_t pc = registration("{\"port\":8790}", false);
    assert(registration_handler(&pc) == ESP_OK && qdd_onboarding_view().pc_fresh);
    atomic_store(&s_download_cancel, true); run_pending_download();
    assert(!atomic_load(&s_download_busy) && m.async_completes == 1 && m.session_closes == 1);

    reset(); m.zip_asset = true; m.native_error_after = 700; m.native_errno = EAGAIN;
    assert(run_exe(&request) == ESP_FAIL && s_download_diag.sent_bytes < sizeof(test_zip));
    assert(m.async_completes == 1 && m.session_closes == 1 && !atomic_load(&s_download_busy));
    assert(!qdd_onboarding_view().downloaded);
    reset(); m.zip_asset = true; m.fail_asset_open = true;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(apk_handler(&request) == ESP_OK && qdd_onboarding_view().downloaded);
}

static void test_zip_range_download(void) {
    reset(); m.zip_asset = true;
    httpd_req_t request = {.handle = (void *)2, .user_ctx = (void *)1, .range = "bytes=0-0"};
    assert(run_exe(&request) == ESP_OK);
    assert(strstr(m.response, "HTTP/1.1 206 Partial Content\r\n"));
    assert(strstr(m.response, "Content-Range: bytes 0-0/5000\r\n"));
    assert(strstr(m.response, "Content-Length: 1\r\n"));
    assert(strstr(m.response, "Accept-Ranges: bytes\r\n") && strstr(m.response, "ETag: \"aaaaaaaa"));
    assert(s_download_diag.sent_bytes == 1 && m.asset_opens == 1 && m.asset_reads == 1);
    assert(m.async_completes == 1 && !atomic_load(&s_download_busy) && !qdd_onboarding_view().downloaded);

    char expected_etag[68]; expected_etag[0] = '"'; memset(expected_etag + 1, 'a', 64);
    expected_etag[65] = '"'; expected_etag[66] = 0;
    const char *invalid[] = {"", "bytes=-10", "bytes=1-", "bytes=0-1,3-4", "bytes=2-1", "bytes=0-5000",
        "bytes=5000-5000", "bytes=4294967296-4294967296", "bytes=0-4294967296", "bytes=+0-1",
        "bytes= 0-1", "Bytes=0-1", "bytes=0-1 ", "bytes=0-1\r\nX: a", "bytes=1--2",
        "bytes=000000000000000000000000000000000000000000000000000000000000000000000000-1"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        reset(); m.zip_asset = true; request.range = invalid[i]; request.if_match = expected_etag;
        assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "416 Range Not Satisfiable"));
        assert(!strcmp(m.content_range, "bytes */5000") && m.asset_reads == 0 && s_download_diag.sent_bytes == 0);
        assert(m.async_completes == 1 && !atomic_load(&s_download_busy));
    }
    const char *bad_matches[] = {NULL, "", "*", "W/\"aaaaaaaa\"", "aaaaaaaa", "\"bbbbbbbb\""};
    for (size_t i = 0; i < sizeof(bad_matches) / sizeof(bad_matches[0]); i++) {
        reset(); m.zip_asset = true; request.range = "bytes=1-2"; request.if_match = bad_matches[i];
        assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "412 Precondition Failed"));
        assert(!strcmp(m.etag, expected_etag) && m.asset_reads == 0 && s_download_diag.sent_bytes == 0);
        assert(m.async_completes == 1 && !atomic_load(&s_download_busy));
    }
    reset(); m.zip_asset = true; request.range = "bytes=0-0"; request.if_match = "wrong";
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "412 Precondition Failed"));
    reset(); m.zip_asset = true; request.range = "bytes=4999-4999"; request.if_match = expected_etag;
    m.asset_next_offset = 4999;
    assert(run_exe(&request) == ESP_OK && s_download_diag.sent_bytes == 1);
    const char *body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
    assert((uint8_t)body[0] == test_zip[4999] && strstr(m.response, "Content-Range: bytes 4999-4999/5000\r\n"));

    // Interrupted ZIP bytes can be resumed in a fresh HTTP request only under
    // the same whole-file ETag, without retaining/owning the failed session.
    uint8_t assembled[sizeof(test_zip)];
    reset(); m.zip_asset = true; m.native_limit = 97; m.native_error_after = 900; m.native_errno = EAGAIN;
    request.range = "bytes=0-4999";
    assert(run_exe(&request) == ESP_FAIL && s_download_diag.sent_bytes > 0 && s_download_diag.sent_bytes < sizeof(test_zip));
    assert(m.async_completes == 1 && m.session_closes == 1 && !atomic_load(&s_download_busy));
    const size_t received = s_download_diag.sent_bytes;
    body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
    assert(m.response_size - (size_t)(body - m.response) == received);
    memcpy(assembled, body, received);
    char remainder[64]; (void)snprintf(remainder, sizeof(remainder), "bytes=%u-4999", (unsigned)received);
    reset(); m.zip_asset = true; m.asset_next_offset = received; request.range = remainder;
    assert(run_exe(&request) == ESP_OK && s_download_diag.sent_bytes == sizeof(test_zip) - received);
    body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
    memcpy(assembled + received, body, sizeof(test_zip) - received);
    assert(!memcmp(assembled, test_zip, sizeof(test_zip)) && m.async_completes == 1 && !m.session_closes);

    reset(); m.zip_asset = true; m.asset_hash_char = 'b'; request.range = remainder;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "412 Precondition Failed"));
    assert(m.asset_opens == 1 && m.asset_reads == 0 && s_download_diag.sent_bytes == 0);
    assert(m.async_completes == 1 && !atomic_load(&s_download_busy));
    reset(); m.zip_asset = true; m.fail_asset_open = true; request.range = "bytes=0-0"; request.if_match = NULL;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable") && m.asset_reads == 0);
    reset(); request.range = "bytes=0-1"; request.user_ctx = NULL;
    assert(run_exe(&request) == ESP_OK && !strcmp(m.status, "416 Range Not Satisfiable"));
}

static void test_async_download_lifecycle(void) {
    reset(); assert(start_http() == ESP_OK);
    httpd_req_t request = {.handle = (void *)2};
    assert(exe_handler(&request) == ESP_OK && atomic_load(&s_download_busy));
    assert(m.pending_task && m.asset_opens == 0 && m.async_begins == 1);
    assert(exe_handler(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(m.async_begins == 1 && strstr(m.response, "busy"));
    // The handler returned before hashing/sending: registrations and status
    // remain serviceable while the separate low-priority worker is pending.
    httpd_req_t pc = registration("{\"port\":8790}", false);
    assert(registration_handler(&pc) == ESP_OK && qdd_onboarding_view().pc_fresh);
    assert(status_handler(&request) == ESP_OK);
    m.response_size = 0; run_pending_download();
    assert(!atomic_load(&s_download_busy) && m.async_completes == 1 && m.deleted_tasks == 1);
    assert(!m.session_closes && !qdd_onboarding_view().downloaded);
    // A later request gets a new worker; no old ownership remains.
    m.asset_next_offset = m.response_size = 0;
    assert(exe_handler(&request) == ESP_OK); run_pending_download();
    assert(m.async_begins == 2 && m.async_completes == 2 && m.deleted_tasks == 2);

    reset(); m.fail_async_begin = true;
    assert(exe_handler(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(!atomic_load(&s_download_busy) && !m.pending_task && m.async_completes == 0);
    reset(); m.fail_task = true;
    assert(exe_handler(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(!atomic_load(&s_download_busy) && m.async_completes == 1 && !m.pending_task);

    reset(); assert(start_http() == ESP_OK); strcpy(s_ip, m.wifi.ip);
    assert(exe_handler(&request) == ESP_OK && m.pending_task);
    m.wifi.connected = false;
    poll_network(100);
    assert(atomic_load(&s_download_cancel) && atomic_load(&s_download_stopping));
    assert(s_http && m.stops == 0); // Server cannot free a live async request.
    m.response_size = 0; run_pending_download();
    assert(m.session_closes == 1 && m.async_completes == 1 && !atomic_load(&s_download_busy));
    // Even if Wi-Fi rapidly returns at the same IP, finish the old epoch.
    m.wifi.connected = true; poll_network(200);
    assert(m.stops == 1 && m.starts == 2 && s_http_ready);
    assert(!atomic_load(&s_download_stopping));
}

static void test_download_resource_backpressure(void) {
    httpd_req_t request = {.handle = (void *)2};
    // Total free bytes and contiguous allocation headroom are independent.
    // Either can temporarily prevent another copy into the TCP producer.
    for (unsigned fragmented = 0; fragmented < 2; fragmented++) {
        reset(); m.pressure_on_read = 1; m.recover_after_delays = 3;
        m.pressure_free = fragmented ? 40000 : 8192;
        m.pressure_largest = fragmented ? 2048 : 8192;
        assert(run_exe(&request) == ESP_OK);
        assert(m.headroom_delays == 3 && s_download_diag.sent_bytes == sizeof(test_exe));
        const char *body = strstr(m.response, "\r\n\r\n"); assert(body); body += 4;
        assert(!memcmp(body, test_exe, sizeof(test_exe)));
        assert(m.async_completes == 1 && !m.session_closes && !atomic_load(&s_download_busy));
    }
    // Also recheck between partial native writes of the same flash chunk.
    reset(); m.native_limit = 1000; m.pressure_on_send = 2;
    m.pressure_free = 8192; m.pressure_largest = 2048; m.recover_after_delays = 2;
    assert(run_exe(&request) == ESP_OK && m.headroom_delays == 2);
    assert(s_download_diag.sent_bytes == sizeof(test_exe));

    // A request that never regains resources aborts within the existing 2 s
    // budget, completes the async request once, and releases busy ownership.
    reset(); m.pressure_on_read = 1; m.pressure_free = 8192; m.pressure_largest = 2048;
    assert(run_exe(&request) == ESP_FAIL);
    assert(m.now == 2000 && m.headroom_delays > 0 && m.native_sends == m.pressure_sends);
    assert(s_download_diag.sent_bytes == 0 && s_download_diag.result == ESP_ERR_NO_MEM);
    assert(m.async_completes == 1 && m.session_closes == 1 && m.deleted_tasks == 1);
    assert(!atomic_load(&s_download_busy) && !qdd_onboarding_view().downloaded);

    for (unsigned stopping = 0; stopping < 2; stopping++) {
        reset(); m.pressure_on_read = 2; m.pressure_free = 8192; m.pressure_largest = 2048;
        if (stopping) m.stop_after_delays = 2; else m.cancel_after_delays = 2;
        assert(run_exe(&request) == ESP_FAIL && m.headroom_delays == 2);
        assert(m.native_sends == m.pressure_sends && s_download_diag.sent_bytes == 2048);
        assert(m.async_completes == 1 && m.session_closes == 1 && !atomic_load(&s_download_busy));
    }
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

static void test_usb_installer(void) {
    reset();
    httpd_req_t request = {0};
    assert(usb_installer_handler(&request) == ESP_OK);
    assert(!strcmp(m.content_type, "application/vnd.microsoft.portable-executable"));
    assert(!strcmp(m.content_encoding, "gzip"));
    assert(!strcmp(m.hash, QDD_USB_INSTALLER_SHA256));
    assert(strstr(m.disposition, "filename=\"qdd-usb-downloader.exe\"") && strstr(m.disposition, "filename*=UTF-8''"));
    assert(m.content_length == QDD_USB_INSTALLER_GZIP_SIZE && m.response_size == QDD_USB_INSTALLER_GZIP_SIZE);
    assert(m.sent_body == (const char *)qdd_usb_installer_start && !memcmp(m.response, qdd_test_usb_installer, m.response_size));
    assert(!qdd_onboarding_view().downloaded && !m.tasks && !m.async_begins && !m.asset_opens);
    m.fail_send = true;
    assert(usb_installer_handler(&request) == ESP_FAIL && !qdd_onboarding_view().downloaded);
    reset(); strcpy(m.peer, "8.8.8.8");
    assert(usb_installer_handler(&request) == ESP_FAIL && !strcmp(m.status, "403 Forbidden"));

    reset(); m.fail_asset_claim = true;
    assert(exe_handler(&request) == ESP_OK && !strcmp(m.status, "503 Service Unavailable"));
    assert(strstr(m.response, "USB download active") && !m.async_begins && !m.asset_releases && !atomic_load(&s_download_busy));
    reset(); m.fail_async_begin = true;
    assert(exe_handler(&request) == ESP_OK && m.asset_claims == 1 && m.asset_releases == 1 && !m.asset_claimed);
    reset(); m.fail_task = true;
    assert(exe_handler(&request) == ESP_OK && m.asset_claims == 1 && m.asset_releases == 1 && !m.asset_claimed);
}

static void test_usb_receiver_http_modes(void) {
    reset();
    httpd_req_t request = {0};
    assert(usb_receiver_handler(&request) == ESP_OK);
    assert(!strcmp(m.content_type, "text/html; charset=utf-8") && !strcmp(m.content_encoding, "gzip"));
    assert(!strcmp(m.hash, QDD_USB_RECEIVER_SHA256));
    assert(strstr(m.disposition, "attachment; filename=\"qdd-usb-receiver.html\"") && strstr(m.disposition, "filename*=UTF-8''"));
    assert(m.content_length == QDD_USB_RECEIVER_GZIP_SIZE && m.response_size == QDD_USB_RECEIVER_GZIP_SIZE);
    assert(m.sent_body == (const char *)qdd_usb_receiver_start && !memcmp(m.response, qdd_test_usb_receiver, m.response_size));
    assert(!qdd_onboarding_view().downloaded && !m.tasks && !m.async_begins && !m.asset_opens);
    reset();
    assert(usb_receiver_page_redirect(&request) == ESP_OK);
    assert(!strcmp(m.status, "307 Temporary Redirect") && !strcmp(m.location, "/"));
    assert(!m.disposition[0] && !m.content_encoding[0] && !m.hash[0]);
    assert(!strcmp(m.content_type, "text/html; charset=utf-8") && strstr(m.response, "href=\"/\""));
    assert(!strstr(m.response, "USB") && !qdd_onboarding_view().downloaded && !m.asset_opens && !m.tasks);
    reset(); request.origin = "https://example.invalid/redirect"; request.user_agent = "//example.invalid/redirect";
    assert(usb_receiver_page_redirect(&request) == ESP_OK && !strcmp(m.location, "/"));
    assert(!strstr(m.response, "example.invalid"));
    reset(); m.fail_send = true;
    assert(usb_receiver_page_redirect(&request) == ESP_FAIL && !qdd_onboarding_view().downloaded);
    reset(); strcpy(m.peer, "8.8.8.8");
    assert(usb_receiver_page_redirect(&request) == ESP_FAIL && !strcmp(m.status, "403 Forbidden") && !m.location[0]);
    request = (httpd_req_t){0};
    reset(); m.fail_send = true;
    assert(usb_receiver_handler(&request) == ESP_FAIL && !qdd_onboarding_view().downloaded);
    reset(); m.native_limit = 17; m.native_error_after = 34;
    assert(usb_receiver_handler(&request) == ESP_ERR_HTTPD_RESP_SEND && !qdd_onboarding_view().downloaded);
    assert(m.native_bytes == 34 && !m.tasks && !m.async_begins);
    reset(); strcpy(m.peer, "8.8.8.8");
    assert(usb_receiver_handler(&request) == ESP_FAIL && !strcmp(m.status, "403 Forbidden"));
    for (int route = 6; route < 8; route++) {
        reset(); m.fail_route = route;
        assert(start_http() == ESP_FAIL && !s_http && !s_http_ready && m.stops == 1);
        m.fail_route = -1;
        assert(start_http() == ESP_OK && s_http_ready && m.route_count == 12);
    }
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
    assert(page_handler(&request) == ESP_OK && strstr(m.response, "下载 Android 手机版"));
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
    assert(m.starts == 2 && s_http && m.route_count == 12);
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
    test_platform_downloads();
    test_download_diagnostics();
    test_zip_download_and_legacy_redirect();
    test_zip_range_download();
    test_async_download_lifecycle();
    test_download_resource_backpressure();
    test_registration_rejections();
    test_usb_installer();
    test_usb_receiver_http_modes();
    test_apk();
    test_dual_stack_peer();
    test_bounded_socket_send_and_diagnostics();
    test_wifi_memory_diagnostics();
    test_udp_and_lifecycle();
    puts("QDD onboarding production handlers, APK download, UDP discovery and lifecycle tests: PASS");
    return 0;
}
