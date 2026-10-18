#include "lvgl.h"
#include "qdd_ui.h"
#include "qdd_onboarding.h"
#include "bsp_display_rounding.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Keep failures observable in native Windows CI instead of opening a CRT dialog.
#undef assert
#define assert(condition) do { if (!(condition)) { fprintf(stderr, "Assertion failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); exit(1); } } while (0)
void qdd_host_lv_assert(const char *file, int line) { fprintf(stderr, "LVGL assertion at %s:%d\n", file, line); exit(1); }

LV_FONT_DECLARE(qdd_cjk_14);
LV_FONT_DECLARE(qdd_cjk_20);
static uint16_t pixels[240 * 320]; // Host-only capture; never part of firmware.
static uint16_t draw_buffer[240 * 20];
static unsigned flushes;
const char *qdd_ble_name(void) { return "QDD-Passport-1234"; }
static qdd_wifi_ap_t s_networks[QDD_SETUP_NETWORK_LIMIT];
static uint32_t s_scan_revision;
bool qdd_wifi_ap(uint8_t index, uint32_t scan_revision, qdd_wifi_ap_t *out) {
    if (!out || index >= QDD_SETUP_NETWORK_LIMIT || scan_revision != s_scan_revision) return false;
    *out = s_networks[index]; return true;
}
static qdd_onboarding_view_t s_onboarding;
qdd_onboarding_view_t qdd_onboarding_view(void) { return s_onboarding; }

static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *data) {
    const lv_draw_buf_t *buffer = lv_display_get_buf_active(display);
    assert(buffer->header.stride == (uint32_t)(area->x2 - area->x1 + 1) * 2);
    const uint16_t *source = (const uint16_t *)data;
    for (int y = area->y1; y <= area->y2; y++) {
        for (int x = area->x1; x <= area->x2; x++) {
            pixels[y * 240 + x] = bsp_display_pixel_outside_rounded_rect(x, y, 240, 320, 30) ? 0 : *source;
            source++;
        }
    }
    flushes++;
    lv_display_flush_ready(display);
}

static uint32_t next_codepoint(const unsigned char **cursor) {
    uint32_t value = *(*cursor)++;
    unsigned remaining = value < 0x80 ? 0 : value < 0xE0 ? 1 : value < 0xF0 ? 2 : 3;
    if (remaining) value &= (1u << (6 - remaining)) - 1;
    while (remaining--) value = (value << 6) | (*(*cursor)++ & 0x3F);
    return value;
}

static unsigned check_text(const lv_font_t *font, const char *text) {
    const unsigned char *cursor = (const unsigned char *)text;
    unsigned width = 0;
    while (*cursor) {
        const uint32_t codepoint = next_codepoint(&cursor);
        if (codepoint < 0x20) continue;
        lv_font_glyph_dsc_t glyph;
        assert(lv_font_get_glyph_dsc(font, &glyph, codepoint, 0));
        assert(!glyph.is_placeholder);
        width += glyph.adv_w;
    }
    return width;
}

static void check_labels(lv_obj_t *object) {
    if (lv_obj_check_type(object, &lv_label_class)) {
        const lv_font_t *font = lv_obj_get_style_text_font(object, LV_PART_MAIN);
        assert(strstr(lv_label_get_text(object), "12345678") == NULL); // Password must never be rendered.
        assert(font == &qdd_cjk_14 || font == &qdd_cjk_20);
        check_text(font, lv_label_get_text(object));
        lv_point_t measured;
        lv_text_get_size(&measured, lv_label_get_text(object), font, 0, 0, lv_obj_get_content_width(object), LV_TEXT_FLAG_NONE);
        assert(measured.x <= lv_obj_get_content_width(object));
        assert(measured.y <= lv_obj_get_content_height(object));
        lv_area_t area;
        lv_obj_get_coords(object, &area);
        assert(area.x1 >= 0 && area.x2 < 240 && area.y1 >= 0 && area.y2 < 320);
    }
    for (uint32_t i = 0; i < lv_obj_get_child_count(object); i++) check_labels(lv_obj_get_child(object, (int32_t)i));
}

static bool has_label(lv_obj_t *object, const char *expected) {
    if (lv_obj_check_type(object, &lv_label_class) && strcmp(lv_label_get_text(object), expected) == 0) return true;
    for (uint32_t i = 0; i < lv_obj_get_child_count(object); i++) {
        if (has_label(lv_obj_get_child(object, (int32_t)i), expected)) return true;
    }
    return false;
}

static bool has_visible_label(lv_obj_t *object, const char *expected) {
    if (lv_obj_has_flag(object, LV_OBJ_FLAG_HIDDEN)) return false;
    if (lv_obj_check_type(object, &lv_label_class) && strcmp(lv_label_get_text(object), expected) == 0) return true;
    for (uint32_t i = 0; i < lv_obj_get_child_count(object); i++) {
        if (has_visible_label(lv_obj_get_child(object, (int32_t)i), expected)) return true;
    }
    return false;
}

static lv_obj_t *find_label(lv_obj_t *object, const char *expected) {
    if (lv_obj_check_type(object, &lv_label_class) && strcmp(lv_label_get_text(object), expected) == 0) return object;
    for (uint32_t i = 0; i < lv_obj_get_child_count(object); i++) {
        lv_obj_t *found = find_label(lv_obj_get_child(object, (int32_t)i), expected);
        if (found) return found;
    }
    return NULL;
}

static lv_obj_t *scan_spinner(lv_obj_t *object) {
    if (lv_obj_check_type(object, &lv_spinner_class)) return object;
    for (uint32_t i = 0; i < lv_obj_get_child_count(object); i++) {
        lv_obj_t *found = scan_spinner(lv_obj_get_child(object, (int32_t)i));
        if (found) return found;
    }
    return NULL;
}

static void check_sidebar(void) {
    // Three fixed theme indicators meet the actual LCD right edge without gaps.
    const int ys[] = {4, 130, 256};
    for (unsigned i = 0; i < 3; i++) for (int row = 0; row < 60; row++) {
        const int y = ys[i] + row;
        int32_t left, right; assert(bsp_display_rounded_row_span(y, 240, 320, 30, &left, &right));
        const int width = row == 0 || row == 59 ? 2 : 4;
        for (int x = right - width + 1; x <= right; x++) assert(pixels[y * 240 + x] == 0xD1C1);
        assert(pixels[y * 240 + right - width] != 0xD1C1);
        if (right < 239) assert(pixels[y * 240 + right + 1] == 0);
    }
    assert(pixels[100 * 240 + 239] != 0xD1C1 && pixels[220 * 240 + 239] != 0xD1C1);
}

static void write_frame(const char *name) {
    check_sidebar();
    static uint16_t incremental[240 * 320];
    memcpy(incremental, pixels, sizeof(pixels));
    lv_obj_invalidate(lv_screen_active()); lv_refr_now(lv_display_get_default());
    assert(memcmp(incremental, pixels, sizeof(pixels)) == 0);
    char path[96];
    snprintf(path, sizeof(path), "%s.ppm", name);
    FILE *file = fopen(path, "wb");
    assert(file);
    fprintf(file, "P6\n240 320\n255\n");
    for (unsigned i = 0; i < 240 * 320; i++) {
        const uint16_t p = pixels[i];
        const unsigned char rgb[] = {(unsigned char)((p >> 11) * 255 / 31),
            (unsigned char)(((p >> 5) & 63) * 255 / 63), (unsigned char)((p & 31) * 255 / 31)};
        fwrite(rgb, 1, 3, file);
    }
    fclose(file);
}

static void check_intro(lv_display_t *display) {
    qdd_ui_require_onboarding(true);
    qdd_setup_model_t setup = {0}; qdd_setup_intro(&setup);
    qdd_wifi_view_t wifi = {0};
    qdd_hid_state_t state = {0};
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "按键指南") && has_visible_label(lv_screen_active(), "开始连接"));
    assert(has_visible_label(lv_screen_active(), "确认开始连接") && has_visible_label(lv_screen_active(), "实体按键位于机身右侧"));
    assert(!has_label(lv_screen_active(), "紧急停止") && !scan_spinner(lv_screen_active()));
    assert(pixels[130 * 240 + 46] == 0x39E7 && pixels[110 * 240 + 60] == 0x0882); // Same actual-device illustration.
    write_frame("first_connection_button_intro");
    assert(qdd_setup_key(&setup, QDD_SETUP_OK, 0, false) == QDD_SETUP_EXIT);
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(setup.page == QDD_SETUP_HOME && qdd_ui_guide_step() == 1);
    assert(has_visible_label(lv_screen_active(), "连接无线网络") && !has_label(lv_screen_active(), "紧急停止"));
    assert(!has_visible_label(lv_screen_active(), "正在扫描 Wi-Fi") && !scan_spinner(lv_screen_active()) && !wifi.scanning);
    write_frame("first_connection_step_one");
    qdd_setup_help(&setup); qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "返回上一级") && has_visible_label(lv_screen_active(), "确认返回"));
    assert(!has_label(lv_screen_active(), "开始连接"));
    assert(qdd_setup_key(&setup, QDD_SETUP_OK, 0, false) == QDD_SETUP_NONE && setup.page == QDD_SETUP_MENU && setup.selection == 2);
    puts("First-connection intro PASS: real-device key guide, short confirm to Wi-Fi step one, no scan or emergency action, settings help unchanged");
}

static void check_pairing_settings(lv_display_t *display) {
    qdd_setup_model_t setup = {0};
    assert(qdd_setup_pair(&setup) == QDD_SETUP_PAIR_PHONE);
    qdd_wifi_view_t wifi = {0};
    qdd_hid_state_t state = {0};
    qdd_ble_status_t ble = {.pairing_open = true};
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, ble, false, 87, 1000, "PAIRING", 1000);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "配对已开启，等待手机"));
    assert(has_visible_label(lv_screen_active(), "配对已重新开启"));
    lv_obj_t *button = find_label(lv_screen_active(), "重新开启配对");
    assert(button && lv_obj_get_style_outline_width(button, 0) == 2);
    assert(has_visible_label(lv_screen_active(), qdd_ble_name()) && has_visible_label(lv_screen_active(), "返回上一级"));
    write_frame("pairing_opened");
    qdd_ui_wifi(&setup, wifi); // No setup change: the existing cache is hit.
    qdd_ui_refresh(&state, ble, false, 87, 5000, "PAIRING", 1000);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "手机蓝牙中选择本设备"));
    assert(lv_obj_get_style_outline_width(button, 0) == 0);
    assert(qdd_setup_key(&setup, QDD_SETUP_OK, 0, false) == QDD_SETUP_PAIR_PHONE);
    qdd_ui_wifi(&setup, wifi); // Reopen does not change the setup model or BLE flags.
    qdd_ui_refresh(&state, ble, false, 87, 5000, "PAIRING", 5000);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "配对已重新开启") && lv_obj_get_style_outline_width(button, 0) == 2);
    write_frame("pairing_reopened");
    ble.connected = ble.passkey_visible = true; ble.passkey = 123;
    qdd_ui_refresh(&state, ble, false, 87, 6000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "000123"));
    assert(lv_obj_get_style_text_font(find_label(lv_screen_active(), "000123"), 0) == &qdd_cjk_20);
    write_frame("pairing_passkey");
    ble.passkey = 456;
    qdd_ui_refresh(&state, ble, false, 87, 6001, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "000456") && !has_label(lv_screen_active(), "000123"));
    ble.encrypted = ble.authenticated = ble.bonded = true;
    qdd_ui_refresh(&state, ble, false, 87, 6002, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "手机已连接") && has_visible_label(lv_screen_active(), "正在准备键盘鼠标"));
    assert(!has_label(lv_screen_active(), "000456"));
    assert(lv_obj_get_style_text_font(find_label(lv_screen_active(), qdd_ble_name()), 0) == &qdd_cjk_14);
    ble.ready = true;
    qdd_ui_refresh(&state, ble, false, 87, 6003, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "可以返回继续连接电脑"));
    assert(!has_label(lv_screen_active(), "配对已重新开启"));
    write_frame("pairing_connected");
    assert(qdd_setup_key(&setup, QDD_SETUP_OK, 0, false) == QDD_SETUP_PAIR_PHONE);
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, ble, false, 87, 6100, "PAIRING", 6100);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "手机已连接") && has_visible_label(lv_screen_active(), "配对已重新开启"));
    assert(lv_obj_get_style_outline_width(button, 0) == 2 && !has_label(lv_screen_active(), "000456"));
    write_frame("pairing_connected_reopened");
    ble = (qdd_ble_status_t){.passkey_visible = true, .passkey = 123}; // Stale code without an open window.
    qdd_ui_wifi(&setup, (qdd_wifi_view_t){.port = 3333}); // Unrelated Wi-Fi update redraws static setup fields.
    qdd_ui_refresh(&state, ble, false, 87, 7000, "PAIRING", 7000);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "配对窗口已关闭") && has_visible_label(lv_screen_active(), "开启手机配对"));
    assert(!has_label(lv_screen_active(), "000123") && has_visible_label(lv_screen_active(), qdd_ble_name()));
    write_frame("pairing_expired");
    assert(qdd_setup_key(&setup, QDD_SETUP_DOWN, 0, false) == QDD_SETUP_NONE);
    qdd_ui_wifi(&setup, wifi); qdd_ui_refresh(&state, ble, false, 87, 7001, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(setup.page == QDD_SETUP_PAIR && has_visible_label(lv_screen_active(), "返回上一级"));
    assert(qdd_setup_key(&setup, QDD_SETUP_OK, 0, false) == QDD_SETUP_NONE && setup.page == QDD_SETUP_MENU);
    puts("Pairing settings PASS: real open/ready/code state, cached reopen feedback, old-code clearing, return navigation, actual LVGL fonts/layout");
}

static void check_completed_guide(lv_display_t *display) {
    qdd_ui_require_onboarding(true);
    qdd_ui_onboarding_skips(false, false);
    qdd_setup_model_t setup = {0};
    qdd_wifi_view_t wifi = {.connected = true, .port = 3333};
    strcpy(wifi.ip, "192.168.1.147");
    qdd_ui_wifi(&setup, wifi);
    s_onboarding = (qdd_onboarding_view_t){.phone_seen = true, .phone_fresh = true, .phone_projecting = true};
    qdd_hid_state_t state = {.connected = true, .encrypted = true, .authenticated = true, .bonded = true,
        .ready = true, .heartbeat_seen = true, .last_ping_ms = 1900};
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, true, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(qdd_ui_guide_step() == 0 && has_visible_label(lv_screen_active(), "可以远程操作"));
    lv_obj_t *completed_screen = lv_screen_active();
    state.last_ping_ms = 0; // A genuine expired lease is displayed immediately.
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, true, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    assert(has_visible_label(lv_screen_active(), "电脑未连接") && has_visible_label(lv_screen_active(), "等待电脑连接"));
    for (unsigned i = 0; i < 20; i++) {
        state.last_ping_ms = i % 2 ? 0 : 1900;
        qdd_ui_refresh(&state, (qdd_ble_status_t){0}, true, 87, 2000, "", 0);
        lv_refr_now(display);
        assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    }
    state.heartbeat_seen = false;
    s_onboarding.pc_fresh = true; // PC inspection does not send a HID PING.
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    assert(has_visible_label(lv_screen_active(), "电脑已连接") && has_visible_label(lv_screen_active(), "可以远程操作"));
    assert(!state.heartbeat_seen && !state.armed);
    write_frame("completed_pc_registered_without_control");
    s_onboarding.phone_projecting = false;
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    assert(has_visible_label(lv_screen_active(), "分享手机画面") && !has_visible_label(lv_screen_active(), "可以远程操作"));
    write_frame("completed_projection_stopped");
    s_onboarding.phone_fresh = false;
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    assert(has_visible_label(lv_screen_active(), "打开手机投屏"));
    write_frame("completed_projection_app_missing");
    s_onboarding.phone_fresh = s_onboarding.phone_projecting = true;
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "可以远程操作"));
    s_onboarding.pc_fresh = false;
    state.heartbeat_seen = true;
    wifi.connected = false; wifi.ip[0] = 0;
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    wifi.connected = true; strcpy(wifi.ip, "192.168.1.147");
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    assert(lv_screen_active() == completed_screen && qdd_ui_guide_step() == 0);
    strcpy(wifi.ip, "192.168.2.147"); // An actual new LAN starts fresh guidance.
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    assert(qdd_ui_guide_step() == 5);
    qdd_ui_require_onboarding(true);
    s_onboarding = (qdd_onboarding_view_t){0};
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, true, 87, 2000, "", 0);
    assert(qdd_ui_guide_step() == 2 && has_visible_label(lv_screen_active(), "跳过此步"));
    qdd_ui_require_onboarding(false);
}

static void check_scan_activity(lv_display_t *display) {
    qdd_setup_model_t setup = {0}; (void)qdd_setup_enter(&setup);
    qdd_wifi_view_t wifi = {.count = 3, .scan_revision = 12}; s_scan_revision = wifi.scan_revision;
    strcpy(s_networks[0].ssid, "Old network");
    qdd_ui_wifi(&setup, wifi); lv_refr_now(display);
    assert(has_visible_label(lv_screen_active(), "1. Old network"));
    wifi.scanning = true;
    qdd_ui_wifi(&setup, wifi); lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_visible_label(lv_screen_active(), "正在扫描 Wi-Fi"));
    assert(has_visible_label(lv_screen_active(), "通常需要 3-5 秒"));
    assert(has_visible_label(lv_screen_active(), "返回上一级"));
    assert(!has_visible_label(lv_screen_active(), "1. Old network"));
    lv_obj_t *spinner = scan_spinner(lv_screen_active());
    assert(spinner && lv_anim_count_running() == 2);
    const lv_value_precise_t initial_angle = lv_arc_get_angle_end(spinner);
    // An identical data view hits the production cache. LVGL must still move
    // the small spinner region without recreating the screen or the widget.
    qdd_ui_wifi(&setup, wifi);
    assert(spinner == scan_spinner(lv_screen_active()));
    lv_tick_inc(250); lv_timer_handler(); lv_refr_now(display);
    assert(lv_arc_get_angle_end(spinner) != initial_angle);
    write_frame("wifi_scanning");
    wifi.scanning = false; qdd_ui_wifi(&setup, wifi); lv_refr_now(display);
    assert(!scan_spinner(lv_screen_active()) && lv_anim_count_running() == 0);
    assert(has_visible_label(lv_screen_active(), "1. Old network"));
    wifi.scanning = true; qdd_ui_wifi(&setup, wifi);
    qdd_setup_error(&setup, "连接失败，请重试"); qdd_ui_wifi(&setup, wifi);
    assert(!scan_spinner(lv_screen_active()) && lv_anim_count_running() == 0);
    (void)qdd_setup_enter(&setup); qdd_ui_wifi(&setup, wifi);
    assert(qdd_setup_key(&setup, QDD_SETUP_OK, wifi.count, true) == QDD_SETUP_NONE);
    assert(setup.page == QDD_SETUP_MENU);
    qdd_ui_wifi(&setup, wifi);
    assert(wifi.scanning && !scan_spinner(lv_screen_active()) && lv_anim_count_running() == 0);
    (void)qdd_setup_enter(&setup); qdd_ui_wifi(&setup, wifi);
    qdd_setup_exit(&setup); qdd_ui_wifi(&setup, wifi);
    assert(!scan_spinner(lv_screen_active()) && lv_anim_count_running() == 0);
    printf("Scan activity PASS: cached animation, old-list hiding, completion/failure/return cleanup\n");
}

int main(int argc, char **argv) {
    assert(argc == 2 || (argc == 3 && (strcmp(argv[2], "--scan") == 0 || strcmp(argv[2], "--guide") == 0 || strcmp(argv[2], "--pair") == 0 || strcmp(argv[2], "--intro") == 0)));
    FILE *inventory = fopen(argv[1], "rb");
    assert(inventory);
    char glyphs[2048] = {0};
    assert(fread(glyphs, 1, sizeof(glyphs) - 1, inventory) > 0);
    fclose(inventory);
    lv_init();
    check_text(&qdd_cjk_14, glyphs);
    check_text(&qdd_cjk_20, glyphs);
    for (unsigned codepoint = 0x20; codepoint < 0x7F; codepoint++) {
        char ascii[] = {(char)codepoint, 0};
        check_text(&qdd_cjk_14, ascii); check_text(&qdd_cjk_20, ascii);
    }
    lv_font_glyph_dsc_t missing;
    assert(!lv_font_get_glyph_dsc(&qdd_cjk_14, &missing, 0x9F98, 0) && missing.is_placeholder);
    assert(!lv_font_get_glyph_dsc(&qdd_cjk_20, &missing, 0x1F600, 0) && missing.is_placeholder);
    lv_display_t *display = lv_display_create(240, 320);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, draw_buffer, NULL, sizeof(draw_buffer), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(display, flush);
    qdd_ui_create();
    if (argc == 3 && strcmp(argv[2], "--intro") == 0) { check_intro(display); return 0; }
    if (argc == 3 && strcmp(argv[2], "--pair") == 0) { check_pairing_settings(display); return 0; }
    if (argc == 3 && strcmp(argv[2], "--scan") == 0) { check_scan_activity(display); return 0; }
    qdd_hid_state_t state = {0};
    qdd_ble_status_t ble = {0};
    qdd_setup_model_t help = {0}; qdd_setup_help(&help);
    qdd_ui_wifi(&help, (qdd_wifi_view_t){0});
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "按键指南"));
    assert(has_label(lv_screen_active(), "上") && has_label(lv_screen_active(), "下") && has_label(lv_screen_active(), "确认"));
    assert(!has_label(lv_screen_active(), "电源"));
    assert(has_label(lv_screen_active(), "上移") && has_label(lv_screen_active(), "下移") && has_label(lv_screen_active(), "执行"));
    assert(has_label(lv_screen_active(), "实体按键位于机身右侧"));
    // The guide is a complete illustrated device, with a screen, attached
    // side buttons, connector lines and adjacent labels rather than loose text.
    assert(pixels[130 * 240 + 46] == 0x39E7); // Gray enclosure outline.
    assert(pixels[110 * 240 + 60] == 0x0882); // Upper-left recessed display.
    assert(pixels[81 * 240 + 94] == 0x10A2); // Actual top strap opening.
    const int button_centers[] = {107, 135, 180};
    for (unsigned i = 0; i < 3; i++) assert(pixels[button_centers[i] * 240 + 148] == 0xBDD7);
    unsigned speaker_strokes = 0;
    for (int y = 193; y < 229; y++) for (int x = 123; x < 138; x++) speaker_strokes += pixels[y * 240 + x] == 0x94F3;
    assert(speaker_strokes > 40); // Lower-right diagonal speaker grille.
    write_frame("button_guide");
    assert(has_label(lv_screen_active(), "返回上一级"));
    // The menu is guarded; returning reveals the existing physical stop latch.
    state.locked = true;
    qdd_setup_exit(&help); qdd_ui_wifi(&help, (qdd_wifi_view_t){0});
    qdd_ui_refresh(&state, ble, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "已紧急停止"));
    state.locked = false;
    qdd_setup_menu(&help); qdd_ui_wifi(&help, (qdd_wifi_view_t){0});
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "返回主界面")); write_frame("device_menu");
    assert(has_label(lv_screen_active(), "重置设备"));
    help.selection = 3; assert(qdd_setup_key(&help, QDD_SETUP_OK, 0, false) == QDD_SETUP_NONE);
    assert(help.page == QDD_SETUP_RESET && help.selection == 0);
    qdd_ui_wifi(&help, (qdd_wifi_view_t){0}); lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "清除并重新开始"));
    assert(has_label(lv_screen_active(), "Wi-Fi、蓝牙配对、引导记录"));
    assert(has_label(lv_screen_active(), "完成后重新进入连接引导"));
    assert(has_label(lv_screen_active(), "确认执行 · 手机需重新配对"));
    write_frame("reset_back_default");
    assert(qdd_setup_key(&help, QDD_SETUP_DOWN, 0, false) == QDD_SETUP_NONE);
    qdd_ui_wifi(&help, (qdd_wifi_view_t){0}); lv_refr_now(display); check_labels(lv_screen_active());
    write_frame("reset_clear_selected");
    qdd_setup_pair(&help); qdd_ui_wifi(&help, (qdd_wifi_view_t){0});
    qdd_ui_refresh(&state, ble, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active()); write_frame("device_pair");
    qdd_setup_exit(&help); qdd_ui_wifi(&help, (qdd_wifi_view_t){0});
    const char *names[] = {"computer", "service", "pair", "hid", "available", "enabled", "locked"};
    for (unsigned i = 0; i < 7; i++) {
        if (i == 2) { state.heartbeat_seen = true; state.last_ping_ms = 1900; ble.pairing_open = true; ble.passkey_visible = true; ble.passkey = 123; }
        if (i == 3) { state.connected = true; state.encrypted = true; state.authenticated = true; state.bonded = true; ble = (qdd_ble_status_t){0}; }
        if (i == 4) state.ready = true;
        if (i == 5) state.armed = true;
        if (i == 6) { state.armed = false; state.locked = true; }
        qdd_ui_refresh(&state, ble, i > 0, i == 0 ? -1 : 87, 2000, "", 0);
        lv_refr_now(display);
        check_labels(lv_screen_active());
        write_frame(names[i]);

    }
    qdd_ui_home_selection(1);
    qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "取消急停") && has_label(lv_screen_active(), "设置"));
    write_frame("home_settings_selected");
    qdd_ui_home_selection(0);
    const char *notes[] = {"PHYSICAL_STOP", "UNLOCKED", "ENABLED", "PAIRING",
        "USB_REPLY_FAILED", "LOCKED", "NOT_CONNECTED", "NOT_AUTHENTICATED", "HID_NOT_READY",
        "HEARTBEAT_EXPIRED", "HID_SEND_FAILED", "BAD_COMMAND", "LINE_TOO_LONG",
        "STARTUP_FAILED", "UNKNOWN"};
    for (unsigned i = 0; i < sizeof(notes) / sizeof(notes[0]); i++) {
        qdd_ui_refresh(&state, ble, true, 87, 2000, notes[i], 1990);
        lv_refr_now(display);
        check_labels(lv_screen_active());
    }
    qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
    lv_refr_now(display);
    const unsigned before_flushes = flushes;
    lv_mem_monitor_t before, after;
    lv_mem_monitor(&before);
    for (unsigned i = 0; i < 100; i++) {
        qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
        lv_refr_now(display);
    }
    lv_mem_monitor(&after);
    assert(flushes == before_flushes);
    assert(before.free_size == after.free_size && before.used_cnt == after.used_cnt);
    qdd_wifi_view_t guide_wifi = {.connected = true, .port = 3333};
    strcpy(guide_wifi.ip, "192.168.101.147");
    qdd_ui_require_onboarding(true);
    qdd_setup_model_t guide_setup = {0};
    qdd_ui_wifi(&guide_setup, guide_wifi);
    state = (qdd_hid_state_t){0};
    ble = (qdd_ble_status_t){0};
    const char *guide_names[] = {"onboarding_scan", "onboarding_install", "onboarding_bluetooth_wait",
        "onboarding_bluetooth", "onboarding_computer", "onboarding_control", "onboarding_stop"};
    for (unsigned i = 0; i < 7; i++) {
        if (i == 1) s_onboarding.downloaded = true;
        if (i == 2) s_onboarding.phone_seen = s_onboarding.phone_fresh = true;
        if (i == 3) { s_onboarding.phone_projecting = true; ble.pairing_open = true; ble.passkey_visible = true; ble.passkey = 123; }
        if (i == 4) { state.connected = state.encrypted = state.authenticated = state.bonded = state.ready = true; ble = (qdd_ble_status_t){0}; }
        if (i == 5) { state.heartbeat_seen = true; state.last_ping_ms = 1900; }
        if (i == 6) state.locked = true;
        qdd_ui_refresh(&state, ble, i >= 5, 87, 2000, "", 0);
        lv_refr_now(display);
        check_labels(lv_screen_active());
        if (i < 2) {
            assert(has_label(lv_screen_active(), "扫码或浏览器打开地址下载"));
            assert(has_label(lv_screen_active(), "手机/电脑/ESP同一局域网"));
            assert(has_visible_label(lv_screen_active(), "跳过此步") && has_visible_label(lv_screen_active(), "设置"));
        }
        if (i < 5) assert(!has_label(lv_screen_active(), "紧急停止") && !has_label(lv_screen_active(), "取消急停"));
        if (i == 2 || i == 3) assert(has_visible_label(lv_screen_active(), "跳过此步") && qdd_ui_guide_step() == 4);
        write_frame(guide_names[i]);
        if (i == 4) {
            s_onboarding.phone_projecting = false;
            qdd_ui_refresh(&state, ble, false, 87, 2000, "", 0);
            lv_refr_now(display);
            check_labels(lv_screen_active());
            write_frame("onboarding_projection");
            s_onboarding.phone_projecting = true;
        }
    }
    // Skip changes guide routing only; the normal screen still reports the
    // actual missing Bluetooth link, with its regular emergency stop action.
    state = (qdd_hid_state_t){0};
    s_onboarding = (qdd_onboarding_view_t){0};
    qdd_ui_require_onboarding(true);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(qdd_ui_guide_step() == 2 && has_visible_label(lv_screen_active(), "跳过此步"));
    qdd_ui_onboarding_skips(true, false);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(qdd_ui_guide_step() == 4 && !has_label(lv_screen_active(), "紧急停止"));
    write_frame("onboarding_skip_app");
    qdd_ui_onboarding_skips(true, true);
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, false, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(qdd_ui_guide_step() == 5 && !has_visible_label(lv_screen_active(), "跳过此步"));
    assert(has_visible_label(lv_screen_active(), "设置") && !has_label(lv_screen_active(), "紧急停止"));
    write_frame("onboarding_skip_bluetooth");
    state.heartbeat_seen = true; state.last_ping_ms = 1900;
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, true, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(qdd_ui_guide_step() == 0 && has_visible_label(lv_screen_active(), "请先配对手机"));
    assert(has_visible_label(lv_screen_active(), "紧急停止"));
    write_frame("onboarding_skip_complete_unconnected");
    qdd_ui_require_onboarding(true); // Configuration/reset clears skip markers.
    qdd_ui_refresh(&state, (qdd_ble_status_t){0}, true, 87, 2000, "", 0);
    lv_refr_now(display); check_labels(lv_screen_active());
    assert(qdd_ui_guide_step() == 2 && has_visible_label(lv_screen_active(), "跳过此步"));
    qdd_ui_require_onboarding(false);
    if (argc == 3 && strcmp(argv[2], "--guide") == 0) {
        check_completed_guide(display);
        puts("Onboarding guide PASS: scan/install/Bluetooth skips, truthful readiness, no guide emergency actions, RAM reset, actual LVGL fonts/layout");
        return 0;
    }
    s_onboarding = (qdd_onboarding_view_t){0};
    qdd_wifi_view_t wifi = {.port = 3333, .count = 7};
    strcpy(s_networks[0].ssid, "Home Wi-Fi");
    strcpy(s_networks[1].ssid, "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    strcpy(s_networks[2].ssid, "网络设备");
    strcpy(s_networks[3].ssid, "\xF0\x9F\x98\x80"); // Unsupported glyph gets stable ID, not a box.
    s_networks[3].bssid[4] = 0xA1; s_networks[3].bssid[5] = 0xB2;
    for (unsigned i = 4; i < 7; i++) snprintf(s_networks[i].ssid, 33, "Network-%u", i + 1);
    qdd_setup_model_t setup = {0};
    const char *setup_names[] = {"wifi_scan", "wifi_list", "wifi_keyboard", "wifi_space", "wifi_actions", "wifi_connecting", "wifi_error", "wifi_return"};
    for (unsigned i = 0; i < 8; i++) {
        if (i == 0) { qdd_setup_enter(&setup); wifi.scanning = true; }
        if (i == 1) wifi.scanning = false;
        if (i == 2) { assert(qdd_setup_select(&setup, "Home Wi-Fi", false)); assert(qdd_setup_append(&setup, "12345678")); }
        if (i == 3) { setup.row = 15; setup.column = 4; setup.choosing_column = true; }
        if (i == 4) qdd_setup_key(&setup, QDD_SETUP_LONG_OK, wifi.count, false);
        if (i == 5) assert(qdd_setup_key(&setup, QDD_SETUP_OK, wifi.count, false) == QDD_SETUP_SAVE);
        if (i == 6) qdd_setup_error(&setup, "连接失败，请重试");
        if (i == 7) { qdd_setup_exit(&setup); wifi.connected = true; strcpy(wifi.ip, "192.168.1.88"); state.armed = false; }
        qdd_ui_wifi(&setup, wifi);
        qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
        lv_refr_now(display);
        check_labels(lv_screen_active());
        write_frame(setup_names[i]);
        if (i == 4) {
            assert(has_label(lv_screen_active(), "删除一位") && has_label(lv_screen_active(), "清空密码"));
            setup.action_index = 3; qdd_ui_wifi(&setup, wifi); lv_refr_now(display); check_labels(lv_screen_active());
            write_frame("wifi_clear_password"); setup.action_index = 0;
        }
    }
    qdd_setup_enter(&setup);
    setup.selection = wifi.count + 1;
    qdd_ui_wifi(&setup, wifi);
    lv_refr_now(display);
    check_labels(lv_screen_active());
    write_frame("wifi_list_back");
    wifi.count = 0;
    setup.selection = 0;
    qdd_ui_wifi(&setup, wifi);
    lv_refr_now(display);
    check_labels(lv_screen_active());
    write_frame("wifi_list_empty");
    wifi.count = 64;
    for (unsigned i = 0; i < 64; i++) snprintf(s_networks[i].ssid, sizeof(s_networks[i].ssid), "Network-%u", i + 1);
    setup.selection = 63; qdd_ui_wifi(&setup, wifi); lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "无线网络 16/17")); write_frame("wifi_64_last_network");
    setup.selection = 64; qdd_ui_wifi(&setup, wifi); lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "无线网络 17/17")); assert(has_label(lv_screen_active(), "重新查找网络"));
    setup.selection = 65; qdd_ui_wifi(&setup, wifi); lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "无线网络 17/17")); write_frame("wifi_64_back");
    wifi.count = 7; setup.selection = 0;
    qdd_ui_wifi(&setup, wifi); lv_refr_now(display);
    strcpy(s_networks[0].ssid, "Updated network"); wifi.scan_revision = ++s_scan_revision;
    qdd_ui_wifi(&setup, wifi); lv_refr_now(display); check_labels(lv_screen_active());
    assert(has_label(lv_screen_active(), "1. Updated network")); // Same count, new scan must refresh.
    qdd_setup_exit(&setup);
    // Earlier skip scenarios intentionally leave an unpaired guide active.
    // Exercise its unchanged QR content before isolating the main-page checks.
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
    lv_refr_now(display);
    assert(qdd_ui_guide_step() == 2);
    const unsigned qr_flushes = flushes;
    lv_mem_monitor(&before);
    for (unsigned i = 0; i < 100; i++) {
        qdd_ui_wifi(&setup, wifi);
        qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
        lv_refr_now(display);
    }
    lv_mem_monitor(&after);
    assert(flushes == qr_flushes && before.free_size == after.free_size && before.used_cnt == after.used_cnt);
    state.connected = state.encrypted = state.authenticated = state.bonded = state.ready = true;
    s_onboarding = (qdd_onboarding_view_t){.phone_seen = true, .phone_fresh = true,
        .phone_projecting = true, .pc_fresh = true};
    // Both the dynamic network address and configuration screen must cache updates.
    for (unsigned screen = 0; screen < 2; screen++) {
        if (screen) { qdd_setup_enter(&setup); qdd_setup_select(&setup, "Home Wi-Fi", false); }
        qdd_ui_wifi(&setup, wifi);
        qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
        lv_refr_now(display);
        if (!screen) {
            assert(qdd_ui_guide_step() == 0 && has_visible_label(lv_screen_active(), "可以远程操作"));
            // Completing the guide is a transition. Measure the stable main
            // view after its next refresh, rather than counting that transition.
            qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
            lv_refr_now(display);
        }
        const unsigned cached_flushes = flushes;
        lv_mem_monitor(&before);
        for (unsigned i = 0; i < 100; i++) {
            qdd_ui_wifi(&setup, wifi);
            qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
            lv_refr_now(display);
        }
        lv_mem_monitor(&after);
        if (flushes != cached_flushes || before.free_size != after.free_size || before.used_cnt != after.used_cnt) {
            fprintf(stderr, "Unchanged screen %u: flushes %u -> %u, free %zu -> %zu, allocations %zu -> %zu\n",
                screen, cached_flushes, flushes, before.free_size, after.free_size, before.used_cnt, after.used_cnt);
        }
        assert(flushes == cached_flushes && before.free_size == after.free_size && before.used_cnt == after.used_cnt);
    }
    // Screen replacement deletes the old tree before building the next one.
    qdd_setup_exit(&setup);
    qdd_ui_wifi(&setup, wifi);
    qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
    lv_refr_now(display);
    lv_mem_monitor(&before);
    size_t minimum_free = before.free_size, maximum_free = before.free_size;
    for (unsigned i = 0; i < 120; i++) {
        qdd_setup_enter(&setup);
        qdd_ui_wifi(&setup, wifi);
        lv_refr_now(display);
        qdd_setup_exit(&setup);
        qdd_ui_wifi(&setup, wifi);
        qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
        lv_refr_now(display);
        lv_mem_monitor(&after);
        assert(after.used_cnt == before.used_cnt);
        // Recreated labels can change TLSF allocation order with text lengths.
        // Require constant live allocations and bounded alignment overhead,
        // rather than a particular allocator-specific repeating period.
        // 128 bytes covers TLSF's observed block alignment variation, not
        // cumulative allocation growth: the live count stays exactly equal.
        if (after.free_size < minimum_free) minimum_free = after.free_size;
        if (after.free_size > maximum_free) maximum_free = after.free_size;
        assert(maximum_free - minimum_free <= 128);
        assert(after.free_size + 128 >= before.free_size);
        if (after.free_biggest_size < 4096) {
            fprintf(stderr, "Replacement %u: free=%zu largest=%zu peak=%zu baseline_free=%zu baseline_largest=%zu\n",
                i, after.free_size, after.free_biggest_size, after.max_used, before.free_size, before.free_biggest_size);
        }
        assert(after.free_biggest_size >= 4096);
        assert(after.max_used <= 20 * 1024);
    }
    lv_mem_monitor(&after);
    assert(before.used_cnt == after.used_cnt);
    printf("LVGL 9.5 glyph/label/layout checks PASS; 100 unchanged refreshes: 0 flushes, stable allocations.\n");
    printf("24KiB LVGL pool: free=%zu, largest=%zu, peak_used=%zu; fonts line heights=%u/%u.\n",
        after.free_size, after.free_biggest_size, after.max_used, qdd_cjk_14.line_height, qdd_cjk_20.line_height);
    return 0;
}
