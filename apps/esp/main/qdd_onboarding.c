#include "qdd_onboarding.h"

#include "qdd_ble.h"
#include "qdd_onboarding_apk.h"
#include "qdd_wifi.h"
#include "esp_http_server.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
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
    const int length = snprintf(buffer, capacity,
        "{\"service\":\"qdd-esp-onboarding\",\"version\":1,"
        "\"boardUrl\":\"http://%s:3334\",\"deviceName\":\"%s\","
        "\"ip\":\"%s\",\"tcpPort\":%u,\"httpPort\":3334,"
        "\"apkSha256\":\"%s\",\"apkSize\":%u,\"downloaded\":%s,"
        "\"phone\":{\"seen\":%s,\"fresh\":%s,\"ip\":\"%s\",\"deviceId\":\"%s\",\"port\":%u,\"projecting\":%s},"
        "\"pc\":{\"fresh\":%s,\"ip\":\"%s\",\"port\":%u},"
        "\"bluetooth\":{\"connected\":%s,\"encrypted\":%s,\"authenticated\":%s,\"bonded\":%s,\"ready\":%s}}",
        wifi.ip, qdd_ble_name(), wifi.ip, (unsigned)wifi.port,
        QDD_ONBOARDING_APK_SHA256, (unsigned)QDD_ONBOARDING_APK_SIZE,
        json_bool(view.downloaded), json_bool(view.phone_seen), json_bool(view.phone_fresh),
        view.phone_ip, view.phone_device_id, (unsigned)view.phone_port, json_bool(view.phone_projecting),
        json_bool(view.pc_fresh), view.pc_ip, (unsigned)view.pc_port,
        json_bool(bluetooth.connected), json_bool(bluetooth.encrypted),
        json_bool(bluetooth.authenticated), json_bool(bluetooth.bonded), json_bool(bluetooth.ready));
    return length > 0 && (size_t)length < capacity ? (size_t)length : 0;
}

static bool private_peer(httpd_req_t *request, char *ip) {
    struct sockaddr_in address;
    socklen_t size = sizeof(address);
    if (getpeername(httpd_req_to_sockfd(request), (struct sockaddr *)&address, &size) != 0 ||
        address.sin_family != AF_INET || !inet_ntop(AF_INET, &address.sin_addr, ip, 16)) return false;
    return qdd_onboarding_private_ipv4(ip);
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
        "body{font:16px/1.7 system-ui,sans-serif;background:#f3f5f9;color:#17243b;margin:0;padding:24px}"
        "main{max-width:560px;margin:auto;background:white;border-radius:24px;padding:24px}"
        "h1{font-size:25px;line-height:1.3}h2{font-size:18px;margin-top:28px}"
        "a{display:block;padding:13px 18px;margin:14px 0;border-radius:12px;background:#246be8;color:white;text-align:center;text-decoration:none}"
        "small{color:#526077}code{overflow-wrap:anywhere}li{margin:8px 0}"
        ".tip{padding:14px;border-radius:12px;background:#fff2d5;border:1px solid #e9bc5b;color:#694700}</style><main>"
        "<h1>把手机连接到电脑遥控</h1>"
        "<p class=\"tip\"><strong>仅支持同一局域网</strong><br>手机、电脑和 ESP 必须连接同一局域网，"
        "例如同一路由器的 Wi-Fi。</p>"
        "<p>可扫描控制板二维码，或在手机浏览器输入屏幕上的 IP 和端口（<code>IP:3334</code>），打开本页下载 App。</p>"
        "<h2>1. 在手机安装设备投屏</h2>"
        "<a href=\"/qdd-remote.apk\" download=\"设备投屏.apk\">下载设备投屏</a>"
        "<small>下载后打开 APK，按手机提示允许安装。已安装则直接打开。</small>"
        "<h2>2. 打开 App，开始共享屏幕</h2><a href=\"qddscreen://setup?esp=http%3A%2F%2F";
    static const char suffix[] =
        "%3A3334\">打开设备投屏</a><p>在 App 点“开始投屏”，同意系统共享屏幕。"
        "首次连接蓝牙时，在手机设置中选择板上显示的蓝牙名称，并核对配对数字。</p>"
        "<h2>3. 在电脑打开设备操作台</h2><p>运行电脑上的设备操作台；"
        "电脑浏览器打开 <code>http://127.0.0.1:8790</code>。这个地址只在电脑上打开。</p>"
        "<p>看到手机画面后，点击画面即可控制，按 Esc 退出。需要立即停止时，按 ESP 下键。</p>"
        "<small>本连接页不需要令牌，也不会因为打开页面而控制手机。</small></main></html>";
    esp_err_t result = httpd_resp_send_chunk(request, prefix, sizeof(prefix) - 1);
    if (result == ESP_OK) result = httpd_resp_send_chunk(request, wifi.ip, strlen(wifi.ip));
    if (result == ESP_OK) result = httpd_resp_send_chunk(request, suffix, sizeof(suffix) - 1);
    if (result == ESP_OK) result = httpd_resp_send_chunk(request, NULL, 0);
    return result;
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
    const uint64_t started = now_ms();
    for (size_t position = 0; position < length;) {
        if (now_ms() - started >= 15000u) return ESP_FAIL;
        const size_t remaining = length - position;
        const size_t chunk = remaining < 1024 ? remaining : 1024;
        const esp_err_t result = httpd_resp_send_chunk(request, (const char *)qdd_apk_start + position, chunk);
        if (result != ESP_OK) return result;
        position += chunk;
        taskYIELD();
    }
    const esp_err_t result = httpd_resp_send_chunk(request, NULL, 0);
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
        char response[1024];
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
    // httpd_stop joins handlers before clearing; a final old-IP POST cannot
    // repopulate the next Wi-Fi epoch with an obsolete registration.
    portENTER_CRITICAL(&s_lock);
    qdd_onboarding_model_clear(&s_model);
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
