#include "qdd_onboarding.h"

#include "qdd_ble.h"
#include "qdd_download_assets.h"
#include "qdd_onboarding_apk.h"
#include "qdd_usb_installer.h"
#include "qdd_usb_receiver.h"
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
extern const uint8_t qdd_driver_js_start[] asm("_binary_qdd_driver_download_js_start");
extern const uint8_t qdd_driver_js_end[] asm("_binary_qdd_driver_download_js_end");
extern const uint8_t qdd_usb_installer_start[] asm("_binary_qdd_usb_installer_exe_start");
extern const uint8_t qdd_usb_installer_end[] asm("_binary_qdd_usb_installer_exe_end");
extern const uint8_t qdd_usb_receiver_start[] asm("_binary_qdd_usb_receiver_html_start");
extern const uint8_t qdd_usb_receiver_end[] asm("_binary_qdd_usb_receiver_html_end");

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
static atomic_bool s_download_busy, s_download_cancel, s_download_stopping;
typedef struct {
    unsigned phase, start_heap, after_verify_heap, min_heap, min_largest, end_heap, sent_bytes;
    int result, socket_errno;
} download_diagnostics_t;
static portMUX_TYPE s_download_diag_lock = portMUX_INITIALIZER_UNLOCKED;
static download_diagnostics_t s_download_diag;

// The ordinary status/UDP response retains its existing 1 KiB bound. Download
// diagnostics use a separate small endpoint and a coherent critical snapshot.
static void download_sample(unsigned phase) {
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    const unsigned heap = (unsigned)heap_caps_get_free_size(caps);
    const unsigned largest = (unsigned)heap_caps_get_largest_free_block(caps);
    portENTER_CRITICAL(&s_download_diag_lock);
    s_download_diag.phase = phase;
    if (heap < s_download_diag.min_heap) s_download_diag.min_heap = heap;
    if (largest < s_download_diag.min_largest) s_download_diag.min_largest = largest;
    if (phase == 2u) s_download_diag.after_verify_heap = heap;
    if (phase == 5u) s_download_diag.end_heap = heap;
    portEXIT_CRITICAL(&s_download_diag_lock);
}

static void download_begin(void) {
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    const unsigned heap = (unsigned)heap_caps_get_free_size(caps);
    const unsigned largest = (unsigned)heap_caps_get_largest_free_block(caps);
    portENTER_CRITICAL(&s_download_diag_lock);
    s_download_diag = (download_diagnostics_t){.phase = 1u, .start_heap = heap,
        .min_heap = heap, .min_largest = largest};
    portEXIT_CRITICAL(&s_download_diag_lock);
}

static void download_failure(esp_err_t result, int socket_errno) {
    portENTER_CRITICAL(&s_download_diag_lock);
    if (s_download_diag.result == ESP_OK) s_download_diag.result = result;
    if (socket_errno) s_download_diag.socket_errno = socket_errno;
    portEXIT_CRITICAL(&s_download_diag_lock);
}

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

size_t qdd_onboarding_download_diagnostics(char *out, size_t capacity) {
    if (!out || !capacity) return 0;
    out[0] = 0;
    const size_t limit = capacity < 256u ? capacity : 256u;
    portENTER_CRITICAL(&s_download_diag_lock);
    const download_diagnostics_t view = s_download_diag;
    const bool busy = atomic_load(&s_download_busy);
    portEXIT_CRITICAL(&s_download_diag_lock);
    const int length = snprintf(out, limit,
        "{\"busy\":%s,\"phase\":%u,\"startHeap\":%u,\"afterVerifyHeap\":%u,"
        "\"minHeap\":%u,\"minLargest\":%u,\"endHeap\":%u,\"sentBytes\":%u,\"result\":%d,\"errno\":%d}",
        json_bool(busy), view.phase, view.start_heap, view.after_verify_heap,
        view.min_heap, view.min_largest, view.end_heap, view.sent_bytes, view.result, view.socket_errno);
    if (length <= 0 || (size_t)length >= limit) { out[0] = 0; return 0; }
    return (size_t)length;
}

static esp_err_t download_status_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    char body[256];
    if (!qdd_onboarding_download_diagnostics(body, sizeof(body))) return ESP_FAIL;
    return json_response(request, "200 OK", body);
}

static bool windows_browser(httpd_req_t *request) {
    char agent[192];
    if (httpd_req_get_hdr_value_str(request, "User-Agent", agent, sizeof(agent)) != ESP_OK) return false;
    // Both explicit downloads remain visible when a custom agent is unknown.
    return strstr(agent, "Windows") != NULL && strstr(agent, "Android") == NULL;
}

static esp_err_t driver_script_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    httpd_resp_set_type(request, "application/javascript; charset=utf-8");
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    return httpd_resp_send(request, (const char *)qdd_driver_js_start,
        (ssize_t)(qdd_driver_js_end - qdd_driver_js_start));
}

static esp_err_t usb_installer_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    const size_t length = (size_t)(qdd_usb_installer_end - qdd_usb_installer_start);
    if (length != QDD_USB_INSTALLER_GZIP_SIZE || !length) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"USB downloader unavailable\"}");
    }
    httpd_resp_set_type(request, "application/vnd.microsoft.portable-executable");
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(request, "Content-Disposition", "attachment; filename=\"qdd-usb-downloader.exe\"; filename*=UTF-8''%E8%AE%BE%E5%A4%87USB%E4%B8%8B%E8%BD%BD%E5%99%A8.exe");
    httpd_resp_set_hdr(request, "X-QDD-EXE-SHA256", QDD_USB_INSTALLER_SHA256);
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    return httpd_resp_send(request, (const char *)qdd_usb_installer_start, (ssize_t)length);
}

static esp_err_t usb_receiver_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    const size_t length = (size_t)(qdd_usb_receiver_end - qdd_usb_receiver_start);
    if (length != QDD_USB_RECEIVER_GZIP_SIZE || !length) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Offline USB page unavailable\"}");
    }
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    const bool inline_page = request->user_ctx != NULL;
    if (!inline_page) httpd_resp_set_hdr(request, "Content-Disposition", "attachment; filename=\"qdd-usb-receiver.html\"; filename*=UTF-8''%E8%AE%BE%E5%A4%87USB%E6%8E%A5%E6%94%B6.html");
    httpd_resp_set_hdr(request, "X-QDD-HTML-SHA256", QDD_USB_RECEIVER_SHA256);
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    // HTTP can render instructions and save the same offline file. The browser
    // still forbids WebSerial in this insecure context; no security exception.
    httpd_resp_set_hdr(request, "Content-Security-Policy", inline_page ?
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'" :
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return httpd_resp_send(request, (const char *)qdd_usb_receiver_start, (ssize_t)length);
}

static esp_err_t usb_receiver_page_redirect(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    // Old browser bookmarks now use the ordinary LAN installation page.
    // The fixed relative destination cannot be supplied by headers or query data.
    httpd_resp_set_status(request, "307 Temporary Redirect");
    httpd_resp_set_hdr(request, "Location", "/");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    return httpd_resp_send(request, "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><a href=\"/\">打开设备安装页</a></html>", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t page_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    if (!wifi.connected || !qdd_onboarding_private_ipv4(wifi.ip)) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Wi-Fi unavailable\"}");
    }
    const bool windows = windows_browser(request);
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    static const char format[] =
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>设备安装</title><style>"
        ":root{color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}"
        "body{font:16px/1.7 system-ui,sans-serif;background:#0e1116;color:#f3f4f6;margin:0;padding:28px 16px}"
        "main{max-width:560px;margin:auto}h1{font-size:25px;line-height:1.3;margin:0 0 20px}"
        "h2{font-size:18px;line-height:1.5;margin:0 0 12px}"
        "section{margin:16px 0;padding:20px;background:#191d24;border:1px solid #303640;border-radius:16px}"
        "p{margin:12px 0;color:#c3c8d0}"
        "a{display:block;padding:13px 18px;margin:14px 0;border-radius:10px;background:#d4380d;color:white;text-align:center;text-decoration:none;font-weight:600}"
        "a:hover{background:#eb481c}a:focus-visible,button:focus-visible{outline:3px solid #ff987d;outline-offset:3px}"
        "progress{width:100%%;height:16px;accent-color:#d4380d}button{font:inherit;min-height:44px;padding:8px 14px;margin:6px 8px 6px 0;background:#303640;color:white;border:1px solid #596474;border-radius:8px}"
        "small{display:block;color:#a8afbb}li{margin:8px 0}button:disabled{opacity:.45}summary{cursor:pointer}"
        ".navigation{display:flex;justify-content:space-between;gap:12px}.counter{color:#a8afbb;font-size:14px}"
        ".secondary{background:#303640}.tip{padding:14px;border-radius:12px;background:#33241f;border:1px solid #704236;color:#f3c1b0}"
        "@media(max-width:380px){body{padding:20px 12px}section{padding:16px}}</style>"
        "<main id=\"download-wizard\" data-platform=\"%s\"><h1>设备安装</h1>"
        "<p id=\"install-counter\" class=\"counter\" hidden></p>"
        "<section id=\"install-step-1\"><h2>1. 连接无线网</h2>"
        "<p class=\"tip\">页面已打开。手机、电脑和设备连接同一个无线网即可。</p>"
        "<p>无需互联网。点击下一步下载安装包。</p></section>"
        "<section id=\"install-step-2\"><h2>2. 下载对应安装包</h2>"
        "<a id=\"recommended-download\" href=\"%s\" download=\"%s\" data-install-platform=\"%s\">%s</a>"
        "<a class=\"secondary\" href=\"%s\" download=\"%s\" data-install-platform=\"%s\">%s</a>"
        "<p id=\"install-download-note\" role=\"status\" aria-live=\"polite\">请在浏览器下载列表中确认文件，再进入下一步。已有安装包可直接继续。</p>"
        "<details><summary>下载遇到问题</summary>"
        "<p>请保持无线网连接。若在扫码软件中打不开，请改用手机或电脑浏览器。</p>"
        "<a class=\"secondary\" href=\"/qdd-desktop.zip\" data-driver-resume>电脑：重新下载并支持续传</a>"
        "<p id=\"driver-download-status\" role=\"status\" aria-live=\"polite\"></p>"
        "<progress id=\"driver-download-progress\" hidden></progress>"
        "<button id=\"driver-download-cancel\" type=\"button\" hidden>取消下载</button>"
        "<button id=\"driver-download-retry\" type=\"button\" hidden>重新下载</button>"
        "</details><small>电脑版适用于 Windows x64，手机版适用于 Android。</small></section>"
        "<section id=\"install-step-3\"><h2>3. 安装并打开</h2>"
        "<div id=\"install-windows\"><h2>Windows 电脑</h2><ol><li>在下载列表找到“设备操作台.zip”。</li>"
        "<li>右键选择“全部解压缩”。</li><li>打开解压后的文件夹，双击“设备操作台”。</li></ol></div>"
        "<div id=\"install-android\"><h2>Android 手机</h2><ol><li>打开下载的“设备投屏.apk”，按手机提示完成安装。</li>"
        "<li>点击下方按钮打开 App，再点“开始投屏”并同意共享屏幕。</li></ol>"
        "<a href=\"qddscreen://setup?esp=http%%3A%%2F%%2F%s%%3A3334\">打开设备投屏</a>"
        "<small>已安装可直接打开。在手机蓝牙设置中选择设备，确认配对即可。</small></div>"
        "<p>请在手机和电脑上分别完成安装。此页不会自动安装或运行程序。</p></section>"
        "<nav id=\"install-navigation\" class=\"navigation\" aria-label=\"安装步骤\" hidden>"
        "<button id=\"install-previous\" type=\"button\">上一步</button><button id=\"install-next\" type=\"button\">下一步</button></nav></main>"
        "<script type=\"module\" src=\"/driver-download.js\"></script></html>";
    // Synchronous HTTPD handlers share this small page without heap allocation.
    static char page[sizeof(format) + 512];
    const int length = snprintf(page, sizeof(page), format,
        windows ? "windows" : "android",
        windows ? "/qdd-desktop.zip" : "/qdd-remote.apk", windows ? "设备操作台.zip" : "设备投屏.apk",
        windows ? "windows" : "android", windows ? "下载 Windows 电脑版" : "下载 Android 手机版",
        windows ? "/qdd-remote.apk" : "/qdd-desktop.zip", windows ? "设备投屏.apk" : "设备操作台.zip",
        windows ? "android" : "windows", windows ? "下载 Android 手机版" : "下载 Windows 电脑版", wifi.ip);
    if (length <= 0 || (size_t)length >= sizeof(page)) return ESP_FAIL;
    return httpd_resp_send(request, page, length);
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

static bool download_cancelled(void) { return atomic_load(&s_download_cancel); }

static esp_err_t wait_download_headroom(void) {
    // v43c completed the EXE and later recovered its heap, but transient Wi-Fi
    // allocation failed at 1700 B while internal free memory reached 952 B.
    // Before another <=2048 B body copy, reserve 16 KiB total / 4 KiB contiguous
    // for queued payload/driver buffers, two small HTTP status/registration
    // requests and control traffic. This conservative admission guard is not
    // an allocator guarantee: concurrent users still require on-device OOM=0.
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    const uint64_t started = now_ms();
    for (;;) {
        if (download_cancelled() || atomic_load(&s_download_stopping)) return ESP_FAIL;
        if (heap_caps_get_free_size(caps) >= 16u * 1024u &&
            heap_caps_get_largest_free_block(caps) >= 4u * 1024u) return ESP_OK;
        download_sample(3u);
        const uint64_t now = now_ms();
        if (now < started || now - started >= 2000u) return ESP_ERR_NO_MEM;
        // Let ACK processing release queued memory without increasing the
        // existing 2 s resource-wait budget or native socket send deadline.
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static esp_err_t send_all(httpd_req_t *request, const char *body, size_t length, bool payload) {
    while (length) {
        if (download_cancelled()) return ESP_FAIL;
        if (payload) {
            const esp_err_t admitted = wait_download_headroom();
            if (admitted != ESP_OK) {
                download_failure(admitted, 0);
                return admitted;
            }
        }
        const int count = httpd_send(request, body, length);
        const int send_errno = count < 0 ? errno : 0;
        if (count <= 0 || (size_t)count > length) {
            download_failure(ESP_ERR_HTTPD_RESP_SEND, send_errno);
            download_sample(3u);
            return ESP_ERR_HTTPD_RESP_SEND;
        }
        if (payload) {
            portENTER_CRITICAL(&s_download_diag_lock);
            s_download_diag.sent_bytes += (unsigned)count;
            portEXIT_CRITICAL(&s_download_diag_lock);
            download_sample(3u);
        }
        body += count;
        length -= (size_t)count;
    }
    return ESP_OK;
}

static bool range_decimal(const char **cursor, uint32_t *value) {
    if (**cursor < '0' || **cursor > '9') return false;
    uint32_t number = 0;
    do {
        const uint32_t digit = (uint32_t)(**cursor - '0');
        if (number > (UINT32_MAX - digit) / 10u) return false;
        number = number * 10u + digit;
        ++*cursor;
    } while (**cursor >= '0' && **cursor <= '9');
    *value = number;
    return true;
}

static bool zip_range(const char *text, uint32_t size, uint32_t *start, uint32_t *end) {
    if (strncmp(text, "bytes=", 6)) return false;
    const char *cursor = text + 6;
    return range_decimal(&cursor, start) && *cursor++ == '-' &&
        range_decimal(&cursor, end) && *cursor == 0 && *start <= *end && *end < size;
}

static esp_err_t send_exe(httpd_req_t *request) {
    static char buffer[QDD_DOWNLOAD_ASSET_CHUNK_SIZE];
    qdd_download_asset_t asset;
    download_sample(1u);
    const esp_err_t opened = qdd_download_assets_open(&asset, download_cancelled, buffer, sizeof(buffer));
    download_sample(2u);
    if (opened != ESP_OK) {
        download_failure(opened, 0);
        if (download_cancelled()) return ESP_FAIL;
        return json_response(request, "503 Service Unavailable",
            "{\"error\":\"Windows driver missing or corrupt; write a verified assets package\"}");
    }
    const bool zipped = asset.kind == QDD_DOWNLOAD_ZIP;
    if (zipped && request->user_ctx == NULL) {
        // Preserve old links without returning ZIP bytes under an EXE name.
        httpd_resp_set_hdr(request, "Location", "/qdd-desktop.zip");
        return json_response(request, "307 Temporary Redirect", "{\"download\":\"/qdd-desktop.zip\"}");
    }
    if (!zipped && request->user_ctx != NULL) {
        return json_response(request, "503 Service Unavailable",
            "{\"error\":\"ZIP unavailable; legacy EXE available at /qdd-desktop.exe\"}");
    }
    uint32_t first = 0, last = asset.size - 1u;
    char requested_range[64] = {0}, etag[68] = {0}, match[68] = {0}, range_header[64] = {0};
    const size_t range_length = httpd_req_get_hdr_value_len(request, "Range");
    const esp_err_t range_result = httpd_req_get_hdr_value_str(request, "Range", requested_range, sizeof(requested_range));
    const bool partial = range_length > 0 || range_result == ESP_OK;
    if (zipped) (void)snprintf(etag, sizeof(etag), "\"%s\"", asset.sha256);
    if (partial && (!zipped || range_length >= sizeof(requested_range) || range_result != ESP_OK ||
                    !zip_range(requested_range, asset.size, &first, &last))) {
        (void)snprintf(range_header, sizeof(range_header), "bytes */%u", (unsigned)asset.size);
        httpd_resp_set_hdr(request, "Content-Range", range_header);
        return json_response(request, "416 Range Not Satisfiable", "{\"error\":\"Use one explicit bytes=start-end ZIP range within the file\"}");
    }
    if (zipped) {
        const size_t match_length = httpd_req_get_hdr_value_len(request, "If-Match");
        const esp_err_t match_result = httpd_req_get_hdr_value_str(request, "If-Match", match, sizeof(match));
        const bool supplied = match_length > 0 || match_result == ESP_OK;
        // The one-byte bootstrap reveals identity, but never resumes content.
        // Every later range is bound to the complete immutable ZIP digest.
        const bool bootstrap = partial && first == 0u && last == 0u && !supplied;
        if ((supplied || (partial && !bootstrap)) &&
            (match_length >= sizeof(match) || match_result != ESP_OK || strcmp(match, etag))) {
            httpd_resp_set_hdr(request, "ETag", etag);
            return json_response(request, "412 Precondition Failed", "{\"error\":\"ZIP changed or exact If-Match ETag missing; restart from metadata\"}");
        }
    }
    if (partial) (void)snprintf(range_header, sizeof(range_header),
        "Content-Range: bytes %u-%u/%u\r\n", (unsigned)first, (unsigned)last, (unsigned)asset.size);
    // The public low-level HTTPD API permits a fixed Content-Length response
    // while reading Flash in bounded chunks. Avoid a complete RAM copy or mmap.
    char headers[512];
    const int length = snprintf(headers, sizeof(headers),
        "HTTP/1.1 %s\r\nContent-Type: %s\r\n"
        "Content-Length: %u\r\nContent-Disposition: attachment; filename=\"device-console.%s\"; "
        "filename*=UTF-8''%%E8%%AE%%BE%%E5%%A4%%87%%E6%%93%%8D%%E4%%BD%%9C%%E5%%8F%%B0.%s\r\n"
        "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-QDD-%s-SHA256: %s\r\n%s%s%s%s\r\n",
        partial ? "206 Partial Content" : "200 OK",
        zipped ? "application/zip" : "application/vnd.microsoft.portable-executable",
        (unsigned)(last - first + 1u), zipped ? "zip" : "exe", zipped ? "zip" : "exe",
        zipped ? "ZIP" : "EXE", asset.sha256,
        zipped ? "Accept-Ranges: bytes\r\nETag: " : "", etag, zipped ? "\r\n" : "", range_header);
    if (length <= 0 || (size_t)length >= sizeof(headers)) return ESP_FAIL;
    esp_err_t result = send_all(request, headers, (size_t)length, false);
    for (size_t offset = first; result == ESP_OK && offset <= last;) {
        const size_t remaining = (size_t)last - offset + 1u;
        const size_t portion = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
        result = qdd_download_assets_read(&asset, offset, buffer, portion);
        if (result == ESP_OK) result = send_all(request, buffer, portion, true);
        offset += portion;
    }
    // Only a successful APK response advances the phone installation milestone.
    // Failed reads/sends abort the session; no truncated EXE is marked complete.
    return result;
}

static void finish_download(httpd_req_t *request, esp_err_t result) {
    const httpd_handle_t server = request->handle;
    const int descriptor = httpd_req_to_sockfd(request);
    // Complete exactly once, including failed/cancelled transfers. The public
    // API releases the copied request even if its final notification fails.
    if (result != ESP_OK) download_failure(result, 0);
    download_sample(4u);
    const esp_err_t completed = httpd_req_async_handler_complete(request);
    if (completed != ESP_OK) download_failure(completed, 0);
    if (result != ESP_OK || completed != ESP_OK) (void)httpd_sess_trigger_close(server, descriptor);
    download_sample(5u);
    portENTER_CRITICAL(&s_download_diag_lock);
    atomic_store(&s_download_busy, false);
    portEXIT_CRITICAL(&s_download_diag_lock);
    qdd_download_assets_release();
}

static void download_worker(void *context) {
    httpd_req_t *request = context;
    finish_download(request, send_exe(request));
    vTaskDelete(NULL);
}

static esp_err_t exe_handler(httpd_req_t *request) {
    if (!allowed_request(request)) return ESP_FAIL;
    bool idle = false;
    if (atomic_load(&s_download_stopping) ||
        !atomic_compare_exchange_strong(&s_download_busy, &idle, true)) {
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Windows download busy; retry after it finishes\"}");
    }
    if (!qdd_download_assets_claim()) {
        atomic_store(&s_download_busy, false);
        return json_response(request, "503 Service Unavailable", "{\"error\":\"USB download active; retry after it finishes\"}");
    }
    atomic_store(&s_download_cancel, false);
    if (atomic_load(&s_download_stopping)) {
        // A Wi-Fi epoch change may race the busy CAS. Never erase its cancel
        // signal or start another worker while stop_network is waiting.
        atomic_store(&s_download_cancel, true);
        atomic_store(&s_download_busy, false);
        qdd_download_assets_release();
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Network changing; retry when connected\"}");
    }
    download_begin();
    httpd_req_t *async = NULL;
    const esp_err_t begun = httpd_req_async_handler_begin(request, &async);
    if (begun != ESP_OK) {
        download_failure(begun, 0);
        download_sample(5u);
        atomic_store(&s_download_busy, false);
        qdd_download_assets_release();
        return json_response(request, "503 Service Unavailable", "{\"error\":\"Download worker unavailable\"}");
    }
    if (xTaskCreate(download_worker, "qdd_download", 4096, async, tskIDLE_PRIORITY + 1, NULL) != pdPASS) {
        download_failure(ESP_ERR_NO_MEM, 0);
        const esp_err_t result = json_response(async, "503 Service Unavailable", "{\"error\":\"Download worker unavailable\"}");
        finish_download(async, result);
    }
    return ESP_OK;
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
    config.max_uri_handlers = 12;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 2;
    config.send_wait_timeout = 2;
    esp_err_t result = httpd_start(&s_http, &config);
    if (result != ESP_OK) { s_http = NULL; return result; }
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_handler},
        {.uri = "/qdd-remote.apk", .method = HTTP_GET, .handler = apk_handler},
        {.uri = "/qdd-desktop.exe", .method = HTTP_GET, .handler = exe_handler},
        {.uri = "/qdd-desktop.zip", .method = HTTP_GET, .handler = exe_handler, .user_ctx = (void *)1},
        {.uri = "/driver-download.js", .method = HTTP_GET, .handler = driver_script_handler},
        {.uri = "/qdd-usb-installer.exe", .method = HTTP_GET, .handler = usb_installer_handler},
        {.uri = "/qdd-usb-receiver.html", .method = HTTP_GET, .handler = usb_receiver_handler},
        {.uri = "/usb-receiver", .method = HTTP_GET, .handler = usb_receiver_page_redirect},
        {.uri = "/api/status", .method = HTTP_GET, .handler = status_handler},
        {.uri = "/api/download-status", .method = HTTP_GET, .handler = download_status_handler},
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
    atomic_store(&s_download_stopping, false);
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
    atomic_store(&s_download_stopping, true);
    if (atomic_load(&s_download_busy)) {
        // Do not destroy HTTPD while its async request still owns a socket.
        // The network worker polls again; neither UI nor control tasks wait.
        atomic_store(&s_download_cancel, true);
        return false;
    }
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
    if ((atomic_load(&s_download_stopping) && s_http) ||
        (!connected && s_ip[0]) || (connected && strcmp(s_ip, wifi.ip) != 0)) {
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
