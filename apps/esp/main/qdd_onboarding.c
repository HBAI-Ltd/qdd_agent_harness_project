#include "qdd_onboarding.h"

#include "qdd_ble.h"
#include "qdd_onboarding_apk.h"
#include "qdd_wifi.h"
#include "esp_http_server.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdatomic.h>
#include <string.h>

extern const uint8_t qdd_apk_start[] asm("_binary_qdd_remote_apk_start");
extern const uint8_t qdd_apk_end[] asm("_binary_qdd_remote_apk_end");

static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static qdd_onboarding_model_t s_model;
static TaskHandle_t s_task;
static httpd_handle_t s_http;
static bool s_http_ready;
static int s_udp = -1;
static char s_ip[16];
static uint64_t s_retry_at;
static atomic_int s_last_send_errno, s_last_send_error, s_last_download_result;
static atomic_uint s_last_download_ms, s_download_successes, s_download_failures;
static wifi_ap_record_t s_status_ap;
static atomic_flag s_status_ap_busy = ATOMIC_FLAG_INIT;

static int bounded_send(httpd_handle_t server, int descriptor, const char *body, size_t length, int flags) {
    (void)server;
    // HTTPD's send_all advances by the returned partial count. Bound each
    // native socket operation so its 2 s deadline covers progress, not an APK.
    const size_t portion = length < 2048u ? length : 2048u;
    const int result = send(descriptor, body, portion, flags);
    if (result <= 0) {
        atomic_store(&s_last_send_errno, result < 0 ? errno : 0);
        atomic_store(&s_last_send_error, result < 0 ? result : HTTPD_SOCK_ERR_FAIL);
        return result < 0 ? result : HTTPD_SOCK_ERR_FAIL;
    }
    return result;
}

static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000u; }
static const char *json_bool(bool value) { return value ? "true" : "false"; }

qdd_onboarding_view_t qdd_onboarding_view(void) {
    const uint64_t now = now_ms();
    portENTER_CRITICAL(&s_lock);
    const qdd_onboarding_view_t view = qdd_onboarding_model_view(&s_model, now);
    portEXIT_CRITICAL(&s_lock);
    return view;
}

static size_t status_json(char *buffer, size_t capacity) {
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    const qdd_ble_status_t bluetooth = qdd_ble_status();
    const qdd_onboarding_view_t view = qdd_onboarding_view();
    if (!wifi.connected || !qdd_onboarding_private_ipv4(wifi.ip)) return 0;
    int rssi = -127, channel = 0;
    // HTTP and UDP may both request status. Avoid a large AP record on either
    // task's stack, and never wait for the other diagnostic reader.
    if (!atomic_flag_test_and_set(&s_status_ap_busy)) {
        if (esp_wifi_sta_get_ap_info(&s_status_ap) == ESP_OK) {
            rssi = s_status_ap.rssi;
            channel = s_status_ap.primary;
        }
        atomic_flag_clear(&s_status_ap_busy);
    }
    wifi_ps_type_t power_save;
    const int ps = esp_wifi_get_ps(&power_save) == ESP_OK ? (int)power_save : -1;
    const int length = snprintf(buffer, capacity,
        "{\"service\":\"qdd-esp-onboarding\",\"version\":1,"
        "\"boardUrl\":\"http://%s:3334\",\"deviceName\":\"%s\","
        "\"ip\":\"%s\",\"tcpPort\":%u,\"httpPort\":3334,"
        "\"apkSha256\":\"%s\",\"apkSize\":%u,\"downloaded\":%s,"
        "\"phone\":{\"seen\":%s,\"fresh\":%s,\"ip\":\"%s\",\"deviceId\":\"%s\",\"port\":%u,\"projecting\":%s},"
        "\"pc\":{\"fresh\":%s,\"ip\":\"%s\",\"port\":%u},"
        "\"bluetooth\":{\"connected\":%s,\"encrypted\":%s,\"authenticated\":%s,\"bonded\":%s,\"ready\":%s},"
        "\"http\":{\"lastSendErrno\":%d,\"lastSendError\":%d,\"lastDownloadResult\":%d,\"lastDownloadMs\":%u,"
        "\"downloadSuccesses\":%u,\"downloadFailures\":%u,\"rssi\":%d,\"channel\":%d,\"ps\":%d,"
        "\"heap\":%u,\"largest\":%u}}",
        wifi.ip, qdd_ble_name(), wifi.ip, (unsigned)wifi.port,
        QDD_ONBOARDING_APK_SHA256, (unsigned)QDD_ONBOARDING_APK_SIZE,
        json_bool(view.downloaded), json_bool(view.phone_seen), json_bool(view.phone_fresh),
        view.phone_ip, view.phone_device_id, (unsigned)view.phone_port, json_bool(view.phone_projecting),
        json_bool(view.pc_fresh), view.pc_ip, (unsigned)view.pc_port,
        json_bool(bluetooth.connected), json_bool(bluetooth.encrypted),
        json_bool(bluetooth.authenticated), json_bool(bluetooth.bonded), json_bool(bluetooth.ready),
        atomic_load(&s_last_send_errno), atomic_load(&s_last_send_error), atomic_load(&s_last_download_result),
        atomic_load(&s_last_download_ms), atomic_load(&s_download_successes), atomic_load(&s_download_failures),
        rssi, channel, ps,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    return length > 0 && (size_t)length < capacity ? (size_t)length : 0;
}

static bool private_peer(httpd_req_t *request, char *ip) {
    struct sockaddr_storage address = {0};
    socklen_t size = sizeof(address);
    if (getpeername(httpd_req_to_sockfd(request), (struct sockaddr *)&address, &size) != 0) return false;
    const void *ipv4 = NULL;
    if (address.ss_family == AF_INET && size >= sizeof(struct sockaddr_in)) {
        ipv4 = &((const struct sockaddr_in *)&address)->sin_addr;
    }
#ifdef AF_INET6
    else if (address.ss_family == AF_INET6 && size >= sizeof(struct sockaddr_in6)) {
        // ESP-IDF's dual-stack HTTP listener reports IPv4 clients as ::ffff:a.b.c.d.
        // Decode the mapped address before applying the existing private-LAN rule.
        static const uint8_t mapped_prefix[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff};
        const uint8_t *bytes = (const uint8_t *)&((const struct sockaddr_in6 *)&address)->sin6_addr;
        if (memcmp(bytes, mapped_prefix, sizeof(mapped_prefix)) == 0) ipv4 = bytes + 12;
    }
#endif
    if (!ipv4 || !inet_ntop(AF_INET, ipv4, ip, 16) || !qdd_onboarding_private_ipv4(ip)) return false;
    // HTTPD emits headers/chunk framing as many small writes. Do not wait for
    // delayed ACKs between them, especially while downloading the local APK.
    const int one = 1;
    const int descriptor = httpd_req_to_sockfd(request);
    (void)setsockopt(descriptor, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return httpd_sess_set_send_override(request->handle, descriptor, bounded_send) == ESP_OK;
}

static esp_err_t json_response(httpd_req_t *request, const char *status, const char *body) {
    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    return httpd_resp_send(request, body, HTTPD_RESP_USE_STRLEN);
}

static bool allowed_request(httpd_req_t *request) {
    char ip[16];
    if (private_peer(request, ip)) return true;
    (void)json_response(request, "403 Forbidden", "{\"error\":\"Private LAN required\"}");
    return false;
}

static esp_err_t status_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    char body[1024];
    if (!status_json(body, sizeof(body))) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Wi-Fi unavailable\"}");
    }
    return json_response(request, "200 OK", body);
}

static esp_err_t page_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    if (!wifi.connected || !qdd_onboarding_private_ipv4(wifi.ip)) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Wi-Fi unavailable\"}");
    }
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    static const char prefix[] =
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>设备控制器 · 连接指引</title><style>"
        ":root{color-scheme:dark}*{box-sizing:border-box}"
        "body{font:16px/1.7 system-ui,sans-serif;background:#0e1116;color:#f3f4f6;margin:0;padding:28px 16px}"
        "main{max-width:560px;margin:auto}h1{font-size:25px;line-height:1.3;margin:0 0 20px}"
        "h2{font-size:18px;line-height:1.5;margin:0 0 12px}"
        "section{margin:16px 0;padding:20px;background:#191d24;border:1px solid #303640;border-radius:16px}"
        "p{margin:12px 0;color:#c3c8d0}"
        "a{display:block;padding:13px 18px;margin:14px 0;border-radius:10px;background:#d4380d;color:white;text-align:center;text-decoration:none;font-weight:600}"
        "a:hover{background:#eb481c}a:focus-visible{outline:3px solid #ff987d;outline-offset:3px}"
        "small{display:block;color:#a8afbb}code{overflow-wrap:anywhere}li{margin:8px 0}"
        ".tip{padding:14px;border-radius:12px;background:#33241f;border:1px solid #704236;color:#f3c1b0}"
        "@media(max-width:380px){body{padding:20px 12px}section{padding:16px}}</style><main>"
        "<h1>把手机连接到电脑遥控</h1>"
        "<p class=\"tip\"><strong>仅支持同一局域网</strong><br>手机、电脑和 ESP 必须连接同一局域网，"
        "例如同一路由器的 Wi-Fi。</p>"
        "<p>可扫描控制板二维码，或在手机浏览器输入屏幕上的 IP 和端口（<code>IP:3334</code>），打开本页下载 App。</p>"
        "<section><h2>1. 在手机安装设备投屏</h2>"
        "<a href=\"/qdd-remote.apk\" download=\"设备投屏.apk\">下载设备投屏</a>"
        "<small>下载后打开 APK，按手机提示允许安装。扫码软件无法下载时，请用手机浏览器打开本页再下载。已安装则直接打开。</small>"
        "</section><section><h2>2. 打开 App，开始共享屏幕</h2><a href=\"qddscreen://setup?esp=http%3A%2F%2F";
    static const char suffix[] =
        "%3A3334\">打开设备投屏</a><p>在 App 点“开始投屏”，同意系统共享屏幕。"
        "首次连接蓝牙时，在手机设置中选择板上显示的蓝牙名称，并核对配对数字。</p>"
        "</section><section><h2>3. 在电脑打开设备操作台</h2><p>运行电脑上的设备操作台；"
        "电脑浏览器打开 <code>http://127.0.0.1:8790</code>。这个地址只在电脑上打开。</p>"
        "<p>看到手机画面后，点击画面即可控制，按 Esc 退出。需要停止时，在控制板选择“紧急停止”并按确认键。</p>"
        "</section><small>本连接页不需要令牌，也不会因为打开页面而控制手机。</small></main></html>";
    // HTTPD runs these synchronous handlers on one worker. Keep the complete
    // small page off its 4 KiB stack and send one response with Content-Length.
    static char page[sizeof(prefix) + 16 + sizeof(suffix)];
    const size_t prefix_length = sizeof(prefix) - 1;
    const size_t ip_length = strlen(wifi.ip);
    const size_t suffix_length = sizeof(suffix) - 1;
    memcpy(page, prefix, prefix_length);
    memcpy(page + prefix_length, wifi.ip, ip_length);
    memcpy(page + prefix_length + ip_length, suffix, suffix_length);
    const size_t length = prefix_length + ip_length + suffix_length;
    return httpd_resp_send(request, page, (ssize_t)length);
}

static esp_err_t apk_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    const size_t length = (size_t)(qdd_apk_end - qdd_apk_start);
    if (length != QDD_ONBOARDING_APK_SIZE || length == 0) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"APK unavailable\"}");
    }
    httpd_resp_set_type(request, "application/vnd.android.package-archive");
    httpd_resp_set_hdr(request, "Content-Disposition", "attachment; filename=\"device-screen.apk\"; filename*=UTF-8''%E8%AE%BE%E5%A4%87%E6%8A%95%E5%B1%8F.apk");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "X-QDD-APK-SHA256", QDD_ONBOARDING_APK_SHA256);
    // Stream from the embedded image through HTTPD's bounded socket writes;
    // avoid per-KiB chunk framing, a second body copy and an app-level deadline.
    const uint64_t started = now_ms();
    atomic_store(&s_last_send_errno, 0);
    atomic_store(&s_last_send_error, 0);
    const esp_err_t result = httpd_resp_send(request, (const char *)qdd_apk_start, (ssize_t)length);
    atomic_store(&s_last_download_result, result);
    atomic_store(&s_last_download_ms, (unsigned)(now_ms() - started));
    if (result == ESP_OK) atomic_fetch_add(&s_download_successes, 1u);
    else atomic_fetch_add(&s_download_failures, 1u);
    if (result == ESP_OK) {
        portENTER_CRITICAL(&s_lock);
        s_model.view.downloaded = true;
        portEXIT_CRITICAL(&s_lock);
    }
    return result;
}

static bool json_request(httpd_req_t *request) {
    char content_type[64];
    if (httpd_req_get_hdr_value_str(request, "Content-Type", content_type, sizeof(content_type)) != ESP_OK ||
        strncmp(content_type, "application/json", 16) != 0 ||
        (content_type[16] && content_type[16] != ';')) return false;
    const size_t origin_length = httpd_req_get_hdr_value_len(request, "Origin");
    if (!origin_length) return true; // Native app and desktop client have no browser Origin.
    char origin[80], expected[64];
    if (origin_length >= sizeof(origin) ||
        httpd_req_get_hdr_value_str(request, "Origin", origin, sizeof(origin)) != ESP_OK) return false;
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    (void)snprintf(expected, sizeof(expected), "http://%s:3334", wifi.ip);
    return strcmp(origin, expected) == 0;
}

static esp_err_t registration_handler(httpd_req_t *request) {
    char peer_ip[16];
    if (!private_peer(request, peer_ip)) {
        (void)json_response(request, "403 Forbidden", "{\"error\":\"Private LAN required\"}");
        return ESP_FAIL;
    }
    if (!json_request(request)) {
        (void)json_response(request, "415 Unsupported Media Type", "{\"error\":\"JSON required\"}");
        return ESP_FAIL;
    }
    if (!request->content_len || request->content_len > QDD_ONBOARDING_BODY_LIMIT) {
        (void)json_response(request, "413 Content Too Large", "{\"error\":\"Body limit is 256 bytes\"}");
        return ESP_FAIL;
    }
    char body[QDD_ONBOARDING_BODY_LIMIT];
    size_t used = 0;
    const uint64_t started = now_ms();
    while (used < request->content_len) {
        if (now_ms() - started >= 2000u) return ESP_FAIL;
        const int received = httpd_req_recv(request, body + used, request->content_len - used);
        if (received <= 0) return ESP_FAIL;
        used += (size_t)received;
    }
    bool accepted = false;
    const bool is_phone = request->user_ctx != NULL;
    qdd_onboarding_phone_t phone;
    uint16_t port = 0;
    if (is_phone ? qdd_onboarding_parse_phone(body, used, &phone) : qdd_onboarding_parse_pc(body, used, &port)) {
        const uint64_t now = now_ms();
        portENTER_CRITICAL(&s_lock);
        accepted = is_phone ? qdd_onboarding_model_phone(&s_model, peer_ip, &phone, now) :
            qdd_onboarding_model_pc(&s_model, peer_ip, port, now);
        portEXIT_CRITICAL(&s_lock);
    }
    return json_response(request, accepted ? "200 OK" : "400 Bad Request",
        accepted ? "{\"ok\":true}" : "{\"error\":\"Invalid registration\"}");
}

static esp_err_t start_http(void) {
    if (s_http) {
        if (s_http_ready) return ESP_OK;
        if (httpd_stop(s_http) != ESP_OK) return ESP_FAIL;
        s_http = NULL;
    }
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = QDD_ONBOARDING_HTTP_PORT;
    config.task_priority = tskIDLE_PRIORITY + 1;
    config.stack_size = 4096;
    config.max_open_sockets = 3;
    config.max_uri_handlers = 5;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 2;
    config.send_wait_timeout = 2;
    esp_err_t result = httpd_start(&s_http, &config);
    if (result != ESP_OK) { s_http = NULL; return result; }
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_handler},
        {.uri = "/qdd-remote.apk", .method = HTTP_GET, .handler = apk_handler},
        {.uri = "/api/status", .method = HTTP_GET, .handler = status_handler},
        {.uri = "/api/phone", .method = HTTP_POST, .handler = registration_handler, .user_ctx = (void *)1},
        {.uri = "/api/pc", .method = HTTP_POST, .handler = registration_handler}
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        result = httpd_register_uri_handler(s_http, &routes[i]);
        if (result != ESP_OK) {
            if (httpd_stop(s_http) == ESP_OK) s_http = NULL;
            return result;
        }
    }
    s_http_ready = true;
    return ESP_OK;
}

static int start_udp(void) {
    const int socket_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (socket_fd < 0) return -1;
    const struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(QDD_ONBOARDING_DISCOVERY_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY)
    };
    const int flags = fcntl(socket_fd, F_GETFL, 0);
    if (flags < 0 || fcntl(socket_fd, F_SETFL, flags | O_NONBLOCK) < 0 ||
        bind(socket_fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
        close(socket_fd);
        return -1;
    }
    return socket_fd;
}

static void poll_udp(void) {
    // Only qdd_onboard calls this function. Keep its response off the 3 KiB
    // task stack: snprintf's newlib formatting chain needs over 1 KiB itself.
    // HTTP handlers retain their own buffer; they must not share this storage.
    static char response[1024];
    // Bound work per tick so discovery floods cannot monopolize the CPU.
    for (unsigned packet = 0; packet < 2; packet++) {
        char request[64], ip[16];
        struct sockaddr_in peer;
        socklen_t peer_size = sizeof(peer);
        int size = recvfrom(s_udp, request, sizeof(request), 0, (struct sockaddr *)&peer, &peer_size);
        if (size < 0) {
            if (errno != EAGAIN && errno != EWOULDBLOCK) { close(s_udp); s_udp = -1; }
            return;
        }
        while (size > 0 && (request[size - 1] == '\r' || request[size - 1] == '\n')) size--;
        if (size != 14 || memcmp(request, "QDD-DISCOVER/1", 14) != 0 || peer.sin_family != AF_INET ||
            !inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip)) || !qdd_onboarding_private_ipv4(ip)) continue;
        const size_t length = status_json(response, sizeof(response));
        if (length) (void)sendto(s_udp, response, length, 0, (const struct sockaddr *)&peer, peer_size);
    }
}

static bool stop_network(void) {
    if (s_udp >= 0) { close(s_udp); s_udp = -1; }
    if (s_http) {
        if (httpd_stop(s_http) != ESP_OK) return false;
        s_http = NULL;
    }
    s_http_ready = false;
    // httpd_stop joins handlers before invalidating; a final old-IP POST cannot
    // repopulate the next Wi-Fi epoch with an obsolete registration.
    portENTER_CRITICAL(&s_lock);
    qdd_onboarding_model_invalidate_network(&s_model);
    portEXIT_CRITICAL(&s_lock);
    s_ip[0] = 0;
    return true;
}

static void poll_network(uint64_t now) {
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    const bool connected = wifi.connected && qdd_onboarding_private_ipv4(wifi.ip);
    if ((!connected && s_ip[0]) || (connected && strcmp(s_ip, wifi.ip) != 0)) {
        if (!stop_network()) return; // Retain ownership and retry; never leak a server handle.
        if (connected) strcpy(s_ip, wifi.ip);
        s_retry_at = 0;
    }
    if (connected) {
        if (now >= s_retry_at) {
            if (!s_http || !s_http_ready) (void)start_http();
            if (s_udp < 0) s_udp = start_udp();
            s_retry_at = now + 5000u;
        }
        if (s_udp >= 0) poll_udp();
    }
}

static void worker(void *context) {
    (void)context;
    for (;;) {
        poll_network(now_ms());
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

esp_err_t qdd_onboarding_start(void) {
    if (s_task) return ESP_OK;
    return xTaskCreate(worker, "qdd_onboard", 3072, NULL, tskIDLE_PRIORITY + 1, &s_task) == pdPASS ?
        ESP_OK : ESP_ERR_NO_MEM;
}
