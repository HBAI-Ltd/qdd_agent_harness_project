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

int main(int argc, char **argv) {
    assert(argc == 2);
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
            assert(has_label(lv_screen_active(), "紧急停止") && has_label(lv_screen_active(), "设置"));
        }
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
    // Both the dynamic network address and configuration screen must cache updates.
    for (unsigned screen = 0; screen < 2; screen++) {
        if (screen) { qdd_setup_enter(&setup); qdd_setup_select(&setup, "Home Wi-Fi", false); }
        qdd_ui_wifi(&setup, wifi);
        qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
        lv_refr_now(display);
        const unsigned cached_flushes = flushes;
        lv_mem_monitor(&before);
        for (unsigned i = 0; i < 100; i++) {
            qdd_ui_wifi(&setup, wifi);
            qdd_ui_refresh(&state, ble, true, 87, 2000, "", 0);
            lv_refr_now(display);
        }
        lv_mem_monitor(&after);
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
