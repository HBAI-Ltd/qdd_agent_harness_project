#include "qdd_ui.h"
#include "qdd_ui_model.h"
#include "qdd_onboarding.h"
#include "bsp_pins.h"
#include "lvgl.h"
#include <stdio.h>
#include <stdatomic.h>
#include <string.h>
LV_FONT_DECLARE(qdd_cjk_14);
LV_FONT_DECLARE(qdd_cjk_20);
_Static_assert(QDD_UI_WIDTH == BSP_LCD_W && QDD_UI_HEIGHT == BSP_LCD_H, "Layout must match LCD");
#define BG 0x141414
#define PANEL 0x222222
#define ACCENT 0xD4380D
#define INK 0xF8ECE7
#define MUTED 0xBAA79E
typedef struct { lv_obj_t *object; char text[96]; } cached_label_t;
typedef enum { MAIN, GUIDE, SETUP } screen_kind_t;
static screen_kind_t s_kind;
static cached_label_t s_header, s_battery, s_computer, s_phone, s_title, s_detail, s_next;
static cached_label_t s_pairing, s_value, s_hint, s_notice, s_rows[5], s_usb_note;
static cached_label_t s_home_rows[2], s_guide_forward;
static unsigned s_home_selection, s_home_action_selection, s_home_action_step;
static bool s_home_action_locked, s_require_onboarding;
static bool s_skip_desktop, s_skip_app, s_skip_bluetooth;
static qdd_driver_usb_view_t s_driver, s_usb_last_driver;
static bool s_usb_cached, s_usb_last_guide, s_usb_last_connected;
static char s_usb_last_ip[16];
static bool s_onboarding_complete;
static char s_onboarding_ip[16];
// One atomic input source: 0 automatic entry, 1..6 selected instructions,
// 7 leaving the guide, 8 dismissed. Render snapshots never overwrite input.
static atomic_uint s_requested_guide_step;
static bool s_display_events_registered, s_finish_after_refresh;
static lv_obj_t *s_keyboard, *s_qrcode, *s_card, *s_scan_spinner, *s_menu_more, *s_menu_previous;
static qdd_setup_model_t s_keyboard_model, s_last_setup;
static qdd_setup_page_t s_setup_page;
static qdd_wifi_view_t s_wifi;
static unsigned s_guide_step, s_last_length;
static bool s_passkey, s_cached;
static uint32_t s_accent;
static char s_qr_url[64];
static void text(cached_label_t *label, const char *value) {
    if (strcmp(label->text, value) == 0) return;
    if (strlen(value) >= sizeof(label->text)) value = "内容过长";
    strcpy(label->text, value); lv_label_set_text(label->object, value);
}
static void label(cached_label_t *slot, lv_obj_t *parent, int x, int y, int width,
                  const char *value, const lv_font_t *font, uint32_t color, bool centered) {
    slot->object = lv_label_create(parent); slot->text[0] = '\0';
    lv_obj_set_pos(slot->object, x, y); lv_obj_set_width(slot->object, width);
    lv_label_set_long_mode(slot->object, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_font(slot->object, font, 0); lv_obj_set_style_text_color(slot->object, lv_color_hex(color), 0);
    lv_obj_set_style_text_line_space(slot->object, 0, 0);
    lv_obj_set_style_text_align(slot->object, centered ? LV_TEXT_ALIGN_CENTER : LV_TEXT_ALIGN_LEFT, 0);
    lv_label_set_text(slot->object, ""); text(slot, value);
}
static void fixed_label(lv_obj_t *parent, int x, int y, int width, const char *value, const lv_font_t *font, uint32_t color, bool centered) {
    cached_label_t slot = {0}; label(&slot, parent, x, y, width, value, font, color, centered);
}
static lv_obj_t *card(lv_obj_t *parent, int x, int y, int width, int height, uint32_t color) {
    lv_obj_t *object = lv_obj_create(parent); lv_obj_set_pos(object, x, y); lv_obj_set_size(object, width, height);
    lv_obj_set_style_bg_color(object, lv_color_hex(color), 0); lv_obj_set_style_border_width(object, 1, 0);
    lv_obj_set_style_border_color(object, lv_color_hex(0x433A35), 0);
    lv_obj_set_style_pad_all(object, 0, 0); lv_obj_set_style_radius(object, 12, 0);
    lv_obj_remove_flag(object, LV_OBJ_FLAG_SCROLLABLE); return object;
}
static void sidebar_draw(lv_event_t *event) {
    lv_layer_t *layer = lv_event_get_layer(event);
    lv_draw_rect_dsc_t bar; lv_draw_rect_dsc_init(&bar);
    bar.bg_color = lv_color_hex(ACCENT); bar.bg_opa = LV_OPA_COVER;
    // Three fixed, text-free indicators touch the actual visible right edge.
    // Follow the board's 30px corner mask instead of clipping straight bars.
    const int ys[] = {4, 130, 256};
    for (unsigned i = 0; i < 3; i++) for (int row = 0; row < 60; row++) {
        const int y = ys[i] + row;
        const int edge = y < 30 ? 30 - y : y >= 290 ? y - 289 : 0;
        int span = 0;
        while (edge && (span + 1) * (span + 1) + edge * edge <= 900) span++;
        const int right = edge ? 209 + span : 239;
        const int width = row == 0 || row == 59 ? 2 : 4;
        lv_area_t area = {right - width + 1, y, right, y}; lv_draw_rect(layer, &bar, &area);
    }
}
static void scan_activity(bool active) {
    if (!active) {
        if (s_scan_spinner) { lv_obj_delete(s_scan_spinner); s_scan_spinner = NULL; }
        return;
    }
    if (s_scan_spinner) return;
    s_scan_spinner = lv_spinner_create(lv_screen_active());
    lv_obj_set_pos(s_scan_spinner, 92, 125); lv_obj_set_size(s_scan_spinner, 40, 40);
    lv_obj_remove_flag(s_scan_spinner, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_arc_color(s_scan_spinner, lv_color_hex(0x433A35), LV_PART_MAIN);
    lv_obj_set_style_arc_color(s_scan_spinner, lv_color_hex(ACCENT), LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(s_scan_spinner, 3, LV_PART_MAIN);
    lv_obj_set_style_arc_width(s_scan_spinner, 3, LV_PART_INDICATOR);
    // LVGL owns the two arc animations, independently of the cached UI view.
    lv_spinner_set_anim_params(s_scan_spinner, 1000, 200);
}
static void menu_more_draw(lv_event_t *event) {
    lv_area_t area; lv_obj_get_coords(lv_event_get_target_obj(event), &area);
    lv_layer_t *layer = lv_event_get_layer(event);
    lv_draw_line_dsc_t line; lv_draw_line_dsc_init(&line);
    line.color = lv_color_hex(0xF58C6C); line.width = 2;
    line.round_start = true; line.round_end = true;
    const int center = (area.x1 + area.x2) / 2;
    if (lv_event_get_user_data(event)) {
        line.p1 = (lv_point_precise_t){center, area.y2 - 1};
        line.p2 = (lv_point_precise_t){center, area.y1 + 2}; lv_draw_line(layer, &line);
        line.p1 = (lv_point_precise_t){area.x1 + 1, area.y2 - 7}; lv_draw_line(layer, &line);
        line.p1 = (lv_point_precise_t){area.x2 - 1, area.y2 - 7}; lv_draw_line(layer, &line);
        return;
    }
    // Draw the requested down arrow without depending on an absent font glyph.
    line.p1 = (lv_point_precise_t){center, area.y1 + 1};
    line.p2 = (lv_point_precise_t){center, area.y2 - 2}; lv_draw_line(layer, &line);
    line.p1 = (lv_point_precise_t){area.x1 + 1, area.y1 + 7}; lv_draw_line(layer, &line);
    line.p1 = (lv_point_precise_t){area.x2 - 1, area.y1 + 7}; lv_draw_line(layer, &line);
}
static lv_obj_t *new_screen(void) {
    s_finish_after_refresh = false;
    s_usb_cached = false;
    scan_activity(false);
    lv_obj_t *screen = lv_obj_create(NULL); lv_obj_set_style_bg_color(screen, lv_color_hex(BG), 0);
    lv_obj_set_style_pad_all(screen, 0, 0); lv_obj_set_style_border_width(screen, 0, 0); lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *old = lv_screen_active(); lv_screen_load(screen); if (old && old != screen) lv_obj_delete(old);
    s_menu_more = s_menu_previous = NULL;
    lv_obj_add_event_cb(screen, sidebar_draw, LV_EVENT_DRAW_POST, NULL);
    return screen;
}
static void home_actions(bool locked, unsigned guide_step) {
    const unsigned choices = qdd_ui_home_choices(guide_step);
    const unsigned selected = choices == 1 ? 0 : s_home_selection;
    if (s_home_action_selection == selected && s_home_action_locked == locked && s_home_action_step == guide_step) return;
    s_home_action_selection = selected; s_home_action_locked = locked; s_home_action_step = guide_step;
    if (guide_step) {
        static const char *actions[] = {"", "选择无线网", "安装手机软件", "连接手机蓝牙", "开始配对", "检查设备连接", "进入主页"};
        const char *action = actions[guide_step];
        text(&s_home_rows[1], action);
        text(&s_guide_forward, guide_step == 6 ? "完成引导" : "下一步");
        lv_obj_set_style_opa(s_home_rows[0].object, guide_step == 1 ? LV_OPA_40 : LV_OPA_COVER, 0);
        return;
    }
    text(&s_home_rows[0], locked ? "取消急停" : "紧急停止");
    text(&s_home_rows[1], "设置");
    for (unsigned i = 0; i < 2; i++) {
        if (choices == 1 && i == 1) lv_obj_add_flag(s_home_rows[i].object, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_remove_flag(s_home_rows[i].object, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(s_home_rows[i].object, lv_color_hex(i == selected ? ACCENT : PANEL), 0);
    }
}
static void home_actions_create(lv_obj_t *screen, bool guide) {
    if (guide) {
        cached_label_t *rows[] = {&s_home_rows[0], &s_home_rows[1], &s_guide_forward};
        const char *values[] = {"上一步", "", "下一步"};
        for (unsigned i = 0; i < 3; i++) {
            label(rows[i], screen, 20, 254 + (int)i * 22, 184, values[i], &qdd_cjk_14,
                i == 1 ? INK : MUTED, true);
            lv_obj_set_height(rows[i]->object, 20);
            lv_obj_set_style_pad_top(rows[i]->object, 1, 0);
            lv_obj_set_style_radius(rows[i]->object, 5, 0);
            lv_obj_set_style_bg_color(rows[i]->object, lv_color_hex(i == 1 ? ACCENT : PANEL), 0);
            lv_obj_set_style_bg_opa(rows[i]->object, LV_OPA_COVER, 0);
        }
        s_home_action_selection = 2; home_actions(false, 1);
        return;
    }
    for (unsigned i = 0; i < 2; i++) {
        label(&s_home_rows[i], screen, 12, 189 + (int)i * 36, 200,
            i ? "设置" : "紧急停止", &qdd_cjk_14, INK, false);
        lv_obj_set_height(s_home_rows[i].object, 31);
        lv_obj_set_style_pad_left(s_home_rows[i].object, 10, 0);
        lv_obj_set_style_pad_top(s_home_rows[i].object, 5, 0);
        lv_obj_set_style_radius(s_home_rows[i].object, 7, 0);
        lv_obj_set_style_bg_opa(s_home_rows[i].object, LV_OPA_COVER, 0);
    }
    s_home_action_selection = 2; home_actions(false, 0);
}
void qdd_ui_require_onboarding(bool required) {
    s_require_onboarding = required;
    s_skip_desktop = s_skip_app = s_skip_bluetooth = false;
    atomic_store(&s_requested_guide_step, required ? 1 : 0);
    if (required) s_onboarding_complete = false;
}
void qdd_ui_onboarding_skips(bool desktop, bool app, bool bluetooth) { s_skip_desktop = desktop; s_skip_app = app; s_skip_bluetooth = bluetooth; }
void qdd_ui_driver(qdd_driver_usb_view_t view) { s_driver = view; }
unsigned qdd_ui_guide_step(void) {
    const unsigned requested = atomic_load(&s_requested_guide_step);
    return requested == 8 ? 0 : requested;
}
void qdd_ui_guide_navigate(bool forward) {
    unsigned current = atomic_load(&s_requested_guide_step);
    while (current >= 1 && current <= 6) {
        const unsigned target = qdd_ui_guide_target(current, forward);
        if (atomic_compare_exchange_weak(&s_requested_guide_step, &current, target)) return;
    }
}
static void main_refresh_ready(lv_event_t *event) {
    (void)event;
    if (!s_finish_after_refresh || s_kind != MAIN) return;
    s_finish_after_refresh = false;
    // REFR_READY follows every rendered area, unlike a screen DRAW_POST which
    // can run for the first tile. Keep double-confirm neutral until then.
    unsigned leaving = 7;
    atomic_compare_exchange_strong(&s_requested_guide_step, &leaving, 8);
}
void qdd_ui_home_selection(unsigned selection) { s_home_selection = selection == 1 ? 1 : 0; }
static void battery(int value) {
    char display[12]; if (value < 0 || value > 100) strcpy(display, "--%"); else snprintf(display, sizeof(display), "%d%%", value);
    text(&s_battery, display);
}
void qdd_ui_create(void) {
    if (!s_display_events_registered) {
        lv_display_add_event_cb(lv_display_get_default(), main_refresh_ready, LV_EVENT_REFR_READY, NULL);
        s_display_events_registered = true;
    }
    lv_obj_t *screen = new_screen(); s_kind = MAIN; s_cached = false;
    label(&s_header, screen, 14, 15, 152, "设备控制器", &qdd_cjk_20, INK, false);
    label(&s_battery, screen, 166, 19, 44, "--%", &qdd_cjk_14, MUTED, false);
    card(screen, 12, 45, 200, 49, PANEL);
    label(&s_computer, screen, 22, 50, 180, "电脑未连接", &qdd_cjk_14, MUTED, false);
    label(&s_phone, screen, 22, 71, 180, "手机未配对", &qdd_cjk_14, MUTED, false);
    card(screen, 12, 102, 200, 79, PANEL);
    label(&s_title, screen, 22, 110, 180, "正在启动", &qdd_cjk_20, 0xF58C6C, false);
    label(&s_detail, screen, 22, 143, 180, "请稍候", &qdd_cjk_14, INK, false);
    home_actions_create(screen, false);
    card(screen, 12, 267, 200, 47, PANEL);
    label(&s_pairing, screen, 22, 269, 180, "", &qdd_cjk_14, MUTED, false);
    label(&s_value, screen, 22, 292, 180, qdd_ble_name(), &qdd_cjk_14, INK, false);
    s_accent = 0;
}
static void guide_progress(lv_event_t *event) {
    lv_layer_t *layer = lv_event_get_layer(event);
    for (unsigned i = 0; i < 6; i++) {
        lv_draw_rect_dsc_t shape; lv_draw_rect_dsc_init(&shape); shape.bg_color = lv_color_hex(i < s_guide_step ? ACCENT : 0x4B3329);
        shape.bg_opa = LV_OPA_COVER; shape.radius = 2; lv_area_t area = {14 + (int)i * 30, 33, 35 + (int)i * 30, 36}; lv_draw_rect(layer, &shape, &area);
    }
}
static void download_qr_create(lv_obj_t *screen, int y) {
    s_qrcode = lv_qrcode_create(screen); lv_qrcode_set_size(s_qrcode, 128); lv_qrcode_set_quiet_zone(s_qrcode, true);
    lv_qrcode_set_dark_color(s_qrcode, lv_color_hex(0)); lv_qrcode_set_light_color(s_qrcode, lv_color_hex(0xFFFFFF));
    lv_obj_set_pos(s_qrcode, 48, y); lv_obj_add_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN);
    // The old screen and QR object have been deleted; identical URLs still
    // need an initial update on this newly allocated canvas.
    s_qr_url[0] = '\0';
}
static bool download_qr_update(const char *ip) {
    char url[64]; snprintf(url, sizeof(url), "http://%s:3334/", ip);
    if (strcmp(url, s_qr_url) == 0) return true;
    if (lv_qrcode_update(s_qrcode, url, (uint32_t)strlen(url)) != LV_RESULT_OK) return false;
    strcpy(s_qr_url, url); return true;
}
// Presentation consumes only a locked snapshot. Transfer completion cannot
// mark software installed, advance onboarding or start network scanning.
static void usb_refresh(bool guide) {
    if (s_usb_cached && s_usb_last_guide == guide && s_usb_last_connected == s_wifi.connected &&
        strcmp(s_usb_last_ip, s_wifi.ip) == 0 && memcmp(&s_usb_last_driver, &s_driver, sizeof(s_driver)) == 0) return;
    s_usb_cached = true; s_usb_last_guide = guide; s_usb_last_connected = s_wifi.connected;
    memcpy(s_usb_last_ip, s_wifi.ip, sizeof(s_usb_last_ip)); s_usb_last_driver = s_driver;
    const char *phase = "等待USB接收页连接", *progress = "只需局域网，无需互联网";
    char amount[48], note[96];
    switch (s_driver.phase) {
    case QDD_DRIVER_USB_CHECKING: phase = "正在校验安装包"; progress = "校验通过后开始传输"; break;
    case QDD_DRIVER_USB_TRANSFERRING:
        phase = "安装包传输中";
        snprintf(amount, sizeof(amount), "已传输 %lu%%", (unsigned long)(s_driver.total_bytes ?
            (uint64_t)(s_driver.transferred_bytes > s_driver.total_bytes ? s_driver.total_bytes : s_driver.transferred_bytes) * 100 / s_driver.total_bytes : 0));
        progress = amount; break;
    case QDD_DRIVER_USB_SENT: phase = "安装包已发送"; progress = "传输完成不等于已安装"; break;
    case QDD_DRIVER_USB_CANCELLED: phase = "传输已取消"; progress = "可重新打开USB接收页"; break;
    case QDD_DRIVER_USB_ERROR:
        phase = "安装包传输失败";
        progress = s_driver.error == QDD_DRIVER_USB_ERROR_ASSET ? "安装包校验未通过" :
            s_driver.error == QDD_DRIVER_USB_ERROR_DISCONNECTED ? "电脑连接已断开" :
            s_driver.error == QDD_DRIVER_USB_ERROR_CONTROL ? "退出电脑控制后重试" :
            s_driver.error == QDD_DRIVER_USB_ERROR_EXPIRED || s_driver.error == QDD_DRIVER_USB_ERROR_CLOCK ?
                "请重新连接USB接收页" : "请检查USB线后重试";
        break;
    case QDD_DRIVER_USB_IDLE: break;
    }
    if (s_driver.phase == QDD_DRIVER_USB_SENT) strcpy(note, "请在电脑确认保存\n解压后启动设备操作台");
    else if (s_wifi.connected && s_wifi.ip[0]) snprintf(note, sizeof(note), "http://%s:3334/", s_wifi.ip);
    else strcpy(note, "已有接收页可直接打开\n首次下载请先连接无线网");
    text(&s_detail, phase);
    // Long instructions live in Flash. Do not expand every label's 96-byte
    // cache or allocate another mutable copy on this no-PSRAM target.
    static const char steps[] = "1 电脑打开下方网址\n2 选择USB备用下载\n3 按网页提示接USB线\n4 保存后解压并打开";
    if (strcmp(lv_label_get_text(s_value.object), steps) != 0) lv_label_set_text_static(s_value.object, steps);
    s_value.text[0] = '\0'; // Following shorter pages must replace the static copy.
    lv_obj_set_style_text_font(s_value.object, &qdd_cjk_14, 0);
    lv_obj_set_style_text_align(s_value.object, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_pos(s_value.object, 22, guide ? 105 : 80); lv_obj_set_width(s_value.object, 180);
    if (guide) {
        s_passkey = false;
        lv_obj_add_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN); lv_obj_remove_flag(s_card, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_pos(s_card, 12, 98); lv_obj_set_size(s_card, 200, 126);
        lv_obj_set_pos(s_hint.object, 22, 203); text(&s_hint, progress);
        lv_obj_set_pos(s_next.object, 14, 225); text(&s_next, note); text(&s_notice, "");
    } else {
        lv_obj_set_pos(s_notice.object, 22, 174); lv_obj_set_width(s_notice.object, 180); text(&s_notice, progress);
        text(&s_usb_note, note);
    }
}
static void guide_create(void) {
    lv_obj_t *screen = new_screen(); s_kind = GUIDE; s_guide_step = 0; s_cached = false;
    lv_obj_add_event_cb(screen, guide_progress, LV_EVENT_DRAW_MAIN, NULL);
    label(&s_header, screen, 14, 10, 152, "连接助手 1/6", &qdd_cjk_14, 0xF58C6C, false);
    label(&s_battery, screen, 166, 10, 44, "--%", &qdd_cjk_14, MUTED, false);
    label(&s_title, screen, 14, 42, 196, "连接无线网", &qdd_cjk_20, INK, true);
    label(&s_detail, screen, 14, 72, 196, "", &qdd_cjk_14, INK, true);
    s_card = card(screen, 12, 110, 200, 102, PANEL);
    download_qr_create(screen, 90);
    label(&s_value, screen, 22, 131, 180, "", &qdd_cjk_14, INK, true);
    label(&s_hint, screen, 22, 171, 180, "", &qdd_cjk_14, MUTED, true);
    label(&s_next, screen, 14, 216, 196, "", &qdd_cjk_14, INK, true);
    label(&s_notice, screen, 14, 235, 196, "", &qdd_cjk_14, 0xFFAC8D, true);
    s_passkey = false; home_actions_create(screen, true);
}
static void guide_refresh(const qdd_ui_view_t *view, qdd_ble_status_t ble, int charge) {
    if (s_kind != GUIDE) guide_create();
    if (s_guide_step != view->onboarding_step) { s_guide_step = view->onboarding_step; lv_obj_invalidate(lv_screen_active()); }
    char value[64]; snprintf(value, sizeof(value), "连接助手 %u/6", view->onboarding_step); text(&s_header, value); battery(charge);
    text(&s_title, view->title);
    const bool passkey = view->onboarding_step == 4 && view->show_passkey && !view->show_qr;
    if (s_passkey != passkey) { s_passkey = passkey; lv_obj_set_style_text_font(s_value.object, passkey ? &qdd_cjk_20 : &qdd_cjk_14, 0); }
    lv_obj_set_y(s_hint.object, view->onboarding_step == 2 ? 181 : 171);
    if (view->onboarding_step == 2) {
        text(&s_detail, view->detail); text(&s_next, view->next); text(&s_notice, "长按确认：设置");
        lv_obj_add_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN); lv_obj_remove_flag(s_card, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_pos(s_card, 12, 110); lv_obj_set_size(s_card, 200, 102);
        lv_obj_set_pos(s_value.object, 22, 131); lv_obj_set_width(s_value.object, 180);
        lv_obj_set_style_text_align(s_value.object, LV_TEXT_ALIGN_CENTER, 0);
        if (s_wifi.connected && s_wifi.ip[0]) snprintf(value, sizeof(value), "http://%s:3334/", s_wifi.ip);
        else strcpy(value, "请先连接无线网");
        text(&s_value, value); text(&s_hint, "电脑和手机连同一无线网");
        lv_obj_set_pos(s_next.object, 14, 216);
        return;
    }
    if (s_usb_cached) {
        s_usb_cached = false;
        lv_obj_set_pos(s_card, 12, 110); lv_obj_set_size(s_card, 200, 102);
        lv_obj_set_pos(s_hint.object, 22, 171);
        lv_obj_set_style_text_align(s_value.object, LV_TEXT_ALIGN_CENTER, 0);
    }
    if (view->show_qr) {
        // Write only the final QR copy: setting generic text before overriding
        // it would invalidate an unchanged page on every presentation tick.
        text(&s_detail, view->detail); (void)download_qr_update(s_wifi.ip);
        lv_obj_remove_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN); lv_obj_add_flag(s_card, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_y(s_value.object, 218); snprintf(value, sizeof(value), "%s:3334", s_wifi.ip); text(&s_value, value);
        text(&s_next, ""); text(&s_hint, ""); text(&s_notice, "长按确认：设置");
    } else {
        text(&s_detail, view->detail); text(&s_next, view->next); text(&s_notice, *view->notice ? view->notice : "长按确认：设置");
        lv_obj_add_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN); lv_obj_remove_flag(s_card, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_y(s_value.object, 131); lv_obj_set_pos(s_next.object, 14, 216); lv_obj_set_width(s_next.object, 196);
        if (view->onboarding_step == 4) {
            if (passkey) snprintf(value, sizeof(value), "%06lu", (unsigned long)ble.passkey); else snprintf(value, sizeof(value), "%s", qdd_ble_name());
            text(&s_value, value); text(&s_hint, passkey ? "在手机输入配对码" : "手机蓝牙中选择本设备");
        } else if (view->onboarding_step == 5 && !view->wait_projection) {
            snprintf(value, sizeof(value), "%s:%u", s_wifi.ip, s_wifi.port); text(&s_value, value); text(&s_hint, "电脑可自动发现");
        } else if (view->onboarding_step == 6) {
            text(&s_value, view->computer); text(&s_hint, view->phone);
        } else if (view->onboarding_step == 3) {
            text(&s_value, "请先连接无线网"); text(&s_hint, "上键返回前面的步骤");
        } else { text(&s_value, view->wait_projection ? "手机App：开始投屏" : s_wifi.connected ? "无线网已连接" : "确认后选择无线网"); text(&s_hint, view->wait_projection ? "允许系统共享屏幕" : "电脑和手机连同一无线网"); }
    }
}
void qdd_ui_refresh(const qdd_hid_state_t *state, qdd_ble_status_t ble, bool computer_live, int charge, uint64_t now, const char *feedback, uint64_t feedback_ms) {
    if (s_kind == SETUP) {
        if (s_setup_page == QDD_SETUP_USB_DOWNLOAD) usb_refresh(false);
        if (s_setup_page == QDD_SETUP_PAIR) {
            const qdd_ui_pairing_view_t pair = qdd_ui_pairing_model(ble.connected,
                ble.encrypted && ble.bonded, ble.ready,
                ble.pairing_open, ble.passkey_visible, ble.passkey, now, feedback, feedback_ms);
            char value[48]; if (pair.show_passkey) snprintf(value, sizeof(value), "%06lu", (unsigned long)ble.passkey); else snprintf(value, sizeof(value), "%s", qdd_ble_name());
            if (s_passkey != pair.show_passkey) { s_passkey = pair.show_passkey; lv_obj_set_style_text_font(s_value.object, pair.show_passkey ? &qdd_cjk_20 : &qdd_cjk_14, 0); }
            text(&s_value, value); text(&s_detail, pair.detail); text(&s_notice, pair.notice); text(&s_rows[0], pair.action);
            lv_obj_set_y(s_notice.object, 108);
            // Every explicit reopen briefly marks the selected action, including
            // when the real window was already open and no BLE flags changed.
            lv_obj_set_style_outline_color(s_rows[0].object, lv_color_hex(0xF58C6C), 0);
            lv_obj_set_style_outline_width(s_rows[0].object, pair.flash_feedback ? 2 : 0, 0);
        }
        return;
    }
    const qdd_onboarding_view_t onboarding = qdd_onboarding_view();
    unsigned requested = atomic_load(&s_requested_guide_step);
    qdd_ui_onboarding_t progress = {.require_full = s_require_onboarding, .wifi_connected = s_wifi.connected, .downloaded = onboarding.downloaded,
        .phone_seen = onboarding.phone_seen, .phone_fresh = onboarding.phone_fresh, .pc_fresh = onboarding.pc_fresh,
        .projecting = onboarding.phone_projecting,
        .skip_desktop = s_skip_desktop, .skip_app = s_skip_app, .skip_bluetooth = s_skip_bluetooth,
        .completed = s_onboarding_complete || requested >= 7, .page = requested <= 6 ? requested : 0};
    qdd_ui_view_t view = qdd_ui_onboarding_model(state, computer_live, ble.pairing_open, ble.passkey_visible, ble.passkey, now, feedback, feedback_ms, &progress);
    if (!requested && view.onboarding_step > 0 && view.onboarding_step < 6) {
        // Existing complete installations bypass setup. Once any instructions
        // are shown, their first page becomes an explicit navigation choice.
        unsigned automatic = 0;
        if (atomic_compare_exchange_strong(&s_requested_guide_step, &automatic, view.onboarding_step)) {
            requested = progress.page = view.onboarding_step;
            view = qdd_ui_onboarding_model(state, computer_live, ble.pairing_open,
                ble.passkey_visible, ble.passkey, now, feedback, feedback_ms, &progress);
        }
    }
    if (!requested && view.onboarding_step == 6) s_onboarding_complete = true;
    const bool guide = view.onboarding_step > 0 && (view.onboarding_step < 6 || progress.page != 0);
    if (guide) { guide_refresh(&view, ble, charge); home_actions(false, view.onboarding_step); return; }
    if (s_kind != MAIN) qdd_ui_create();
    battery(charge); text(&s_computer, view.computer); text(&s_phone, view.phone); text(&s_title, view.title); text(&s_detail, *view.notice ? view.notice : view.detail);
    home_actions(state->locked, 0);
    text(&s_pairing, view.pairing);
    char value[48]; if (view.show_passkey) snprintf(value, sizeof(value), "%06lu", (unsigned long)ble.passkey);
    else snprintf(value, sizeof(value), "%s", qdd_ble_name());
    text(&s_value, value);
    if (s_accent != view.accent) { s_accent = view.accent; lv_obj_set_style_text_color(s_title.object, lv_color_hex(s_accent), 0); }
    s_finish_after_refresh = requested == 7;
}
static bool ssid_display(char *output, size_t capacity, const char *ssid, unsigned number,
                         const uint8_t bssid[6], int content_width) {
    // The selected bytes stay intact in the model. Unsupported or invalid SSIDs
    // get an explicit stable identifier, never missing-glyph boxes or false text.
    char prefix[16]; snprintf(prefix, sizeof(prefix), "%u. ", number);
    lv_point_t prefix_size, ellipsis_size;
    lv_text_get_size(&prefix_size, prefix, &qdd_cjk_14, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    lv_text_get_size(&ellipsis_size, "...", &qdd_cjk_14, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    const int full_width = content_width - prefix_size.x;
    const int abbreviated_width = full_width - ellipsis_size.x;
    size_t offset = 0, kept = 0;
    unsigned width = 0;
    while (ssid[offset] && offset < 32) {
        const unsigned char first = (unsigned char)ssid[offset];
        const unsigned count = first < 0x80 ? 1 : first >= 0xC2 && first <= 0xDF ? 2 :
            first >= 0xE0 && first <= 0xEF ? 3 : first >= 0xF0 && first <= 0xF4 ? 4 : 0;
        uint32_t codepoint = count == 1 ? first : first & ((1u << (7 - count)) - 1u);
        if (!count || offset + count > 32) goto fallback;
        for (unsigned i = 1; i < count; i++) {
            const unsigned char continuation = (unsigned char)ssid[offset + i];
            if ((continuation & 0xC0) != 0x80) goto fallback;
            codepoint = (codepoint << 6) | (continuation & 0x3F);
        }
        if ((count == 2 && codepoint < 0x80) || (count == 3 && codepoint < 0x800) ||
            (count == 4 && codepoint < 0x10000) || codepoint > 0x10FFFF ||
            (codepoint >= 0xD800 && codepoint <= 0xDFFF)) goto fallback;
        lv_font_glyph_dsc_t glyph;
        if (codepoint < 0x20 || !lv_font_get_glyph_dsc(&qdd_cjk_14, &glyph, codepoint, 0) || glyph.is_placeholder) goto fallback;
        width += glyph.adv_w;
        offset += count;
        if (abbreviated_width > 0 && width <= (unsigned)abbreviated_width) kept = offset;
    }
    if (!offset) goto fallback;
    if (full_width > 0 && width <= (unsigned)full_width) kept = offset;
    snprintf(output, capacity, "%s%.*s%s", prefix, (int)kept, ssid, kept < offset ? "..." : "");
    return true;
fallback:
    snprintf(output, capacity, "%u. 网络 %02X%02X", number, bssid[4], bssid[5]);
    return false;
}

static void keyboard_draw(lv_event_t *event) {
    lv_layer_t *layer = lv_event_get_layer(event); lv_area_t origin; lv_obj_get_coords(s_keyboard, &origin);
    const unsigned first_row = qdd_setup_keyboard_page(&s_keyboard_model) * QDD_SETUP_VISIBLE_ROWS;
    for (unsigned row = 0; row < QDD_SETUP_VISIBLE_ROWS; row++) for (unsigned column = 0; column < 6; column++) {
        const unsigned index = (first_row + row) * 6 + column; if (index >= 95) continue;
        const bool active_row = first_row + row == s_keyboard_model.row;
        const bool selected = active_row && (!s_keyboard_model.choosing_column || column == s_keyboard_model.column);
        const char character = qdd_setup_character(index);
        lv_area_t cell = {origin.x1 + (int)column * 28, origin.y1 + (int)row * 33,
            origin.x1 + (int)column * 28 + (character == ' ' ? 53 : 25), origin.y1 + (int)row * 33 + 29};
        lv_draw_rect_dsc_t rectangle; lv_draw_rect_dsc_init(&rectangle); rectangle.radius = 5;
        rectangle.bg_color = lv_color_hex(selected ? ACCENT : active_row ? 0x653020 : PANEL); rectangle.bg_opa = LV_OPA_COVER;
        lv_draw_rect(layer, &rectangle, &cell);
        char value[8] = {character, 0}; if (character == ' ') strcpy(value, "空格");
        lv_draw_label_dsc_t description; lv_draw_label_dsc_init(&description); description.font = &qdd_cjk_14;
        description.color = lv_color_hex(INK); description.align = LV_TEXT_ALIGN_CENTER; description.text = value; description.text_local = true;
        cell.y1 += 4; lv_draw_label(layer, &description, &cell);
    }
}
static void guide_device_draw(lv_event_t *event) {
    lv_layer_t *layer = lv_event_get_layer(event);
    lv_draw_rect_dsc_t shape; lv_draw_rect_dsc_init(&shape);
    // Simplified actual enclosure: tall translucent-gray shell, top strap
    // opening, upper-left display, lower-right diagonal speaker grille.
    shape.bg_opa = LV_OPA_COVER; shape.border_width = 1;
    shape.bg_color = lv_color_hex(0x3A3D3F); shape.border_color = lv_color_hex(0x95908A); shape.radius = 16;
    lv_area_t area = {44, 74, 145, 238}; lv_draw_rect(layer, &shape, &area);
    shape.bg_color = lv_color_hex(0x303436); shape.border_color = lv_color_hex(0x626866); shape.radius = 12;
    area = (lv_area_t){48, 78, 141, 234}; lv_draw_rect(layer, &shape, &area);
    shape.bg_color = lv_color_hex(0x555957); shape.border_color = lv_color_hex(0x999A95); shape.radius = 5;
    area = (lv_area_t){77, 73, 113, 88}; lv_draw_rect(layer, &shape, &area);
    shape.bg_color = lv_color_hex(BG); shape.border_width = 0; shape.radius = 3;
    area = (lv_area_t){83, 77, 107, 84}; lv_draw_rect(layer, &shape, &area);
    shape.bg_color = lv_color_hex(0xA5A399); shape.border_color = lv_color_hex(0xCAC6B9); shape.border_width = 1; shape.radius = 6;
    area = (lv_area_t){51, 92, 119, 186}; lv_draw_rect(layer, &shape, &area);
    shape.bg_color = lv_color_hex(0x0F1011); shape.border_color = lv_color_hex(0x4E5555); shape.radius = 5;
    area = (lv_area_t){55, 97, 115, 180}; lv_draw_rect(layer, &shape, &area);
    shape.bg_color = lv_color_hex(0x343B3B); shape.border_color = lv_color_hex(0x737B79); shape.radius = 7;
    area = (lv_area_t){122, 191, 138, 230}; lv_draw_rect(layer, &shape, &area);
    lv_draw_line_dsc_t line; lv_draw_line_dsc_init(&line);
    line.color = lv_color_hex(0x969C9C); line.width = 2; line.round_start = true; line.round_end = true;
    for (int i = 0; i < 5; i++) {
        line.p1 = (lv_point_precise_t){125, 204 + i * 5}; line.p2 = (lv_point_precise_t){135, 194 + i * 5};
        lv_draw_line(layer, &line);
    }
    // Centers are about 20%, 37%, 65% down the photographed enclosure.
    const int ys[] = {101, 129, 174}, ends[] = {100, 144, 190};
    shape.bg_color = lv_color_hex(0xB8BAB9); shape.border_color = lv_color_hex(0xE5E4DE); shape.border_width = 1; shape.radius = 2;
    for (unsigned i = 0; i < 3; i++) {
        area = (lv_area_t){146, ys[i], 151, ys[i] + 12}; lv_draw_rect(layer, &shape, &area);
        line.color = lv_color_hex(MUTED); line.width = 1; line.round_start = false; line.round_end = false;
        line.p1 = (lv_point_precise_t){152, ys[i] + 6}; line.p2 = (lv_point_precise_t){164, ends[i]}; lv_draw_line(layer, &line);
    }
}
static void setup_create(qdd_setup_page_t page) {
    lv_obj_t *screen = new_screen(); s_kind = SETUP; s_setup_page = page;
    memset(s_rows, 0, sizeof(s_rows)); s_keyboard = NULL;
    if (page == QDD_SETUP_DOWNLOAD) card(screen, 12, 70, 200, 176, PANEL);
    if (page == QDD_SETUP_USB_DOWNLOAD) card(screen, 12, 72, 200, 131, PANEL);
    label(&s_header, screen, 14, 14, 196, "设备设置", &qdd_cjk_20, INK, false);
    label(&s_detail, screen, 14, 47, 196, "", &qdd_cjk_14, MUTED, false);
    label(&s_value, screen, 14, 74, 196, "", &qdd_cjk_14, 0xF58C6C, false);
    for (unsigned i = 0; i < 5; i++) {
        if ((page == QDD_SETUP_RESET && i > 1) || page == QDD_SETUP_PASSWORD || (i != 4 && (page == QDD_SETUP_HELP || page == QDD_SETUP_DOWNLOAD || page == QDD_SETUP_USB_DOWNLOAD || page == QDD_SETUP_CONNECTING ||
            ((page == QDD_SETUP_PAIR || page == QDD_SETUP_ERROR) && i > 0) ||
            (page == QDD_SETUP_ACTIONS && i > 3)))) continue;
        label(&s_rows[i], screen, 12, i == 4 ? 251 : 108 + (int)i * 35, 200, "", &qdd_cjk_14, INK, false);
        lv_obj_set_height(s_rows[i].object, 31); lv_obj_set_style_pad_left(s_rows[i].object, 8, 0); lv_obj_set_style_pad_top(s_rows[i].object, 5, 0);
        lv_obj_set_style_radius(s_rows[i].object, 6, 0); lv_obj_set_style_bg_opa(s_rows[i].object, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(s_rows[i].object, lv_color_hex(PANEL), 0);
    }
    if (page == QDD_SETUP_PASSWORD) {
        s_keyboard = lv_obj_create(screen); lv_obj_remove_style_all(s_keyboard); lv_obj_set_pos(s_keyboard, 14, 104); lv_obj_set_size(s_keyboard, 168, 132);
        lv_obj_remove_flag(s_keyboard, LV_OBJ_FLAG_SCROLLABLE); lv_obj_add_event_cb(s_keyboard, keyboard_draw, LV_EVENT_DRAW_MAIN, NULL);
    }
    label(&s_hint, screen, 14, 290, 196, "上下选择 · 确认进入", &qdd_cjk_14, MUTED, false);
    label(&s_notice, screen, 14, 265, 196, "", &qdd_cjk_14, 0xF58C6C, false);
    if (page == QDD_SETUP_MENU) {
        s_menu_more = lv_obj_create(screen); lv_obj_remove_style_all(s_menu_more);
        lv_obj_set_pos(s_menu_more, 216, 228); lv_obj_set_size(s_menu_more, 12, 14);
        lv_obj_remove_flag(s_menu_more, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(s_menu_more, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_event_cb(s_menu_more, menu_more_draw, LV_EVENT_DRAW_MAIN, NULL);
        s_menu_previous = lv_obj_create(screen); lv_obj_remove_style_all(s_menu_previous);
        lv_obj_set_pos(s_menu_previous, 216, 90); lv_obj_set_size(s_menu_previous, 12, 14);
        lv_obj_remove_flag(s_menu_previous, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(s_menu_previous, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_event_cb(s_menu_previous, menu_more_draw, LV_EVENT_DRAW_MAIN, (void *)1);
    }
    s_passkey = false; s_cached = false; memset(&s_keyboard_model, 0, sizeof(s_keyboard_model));
    if (page == QDD_SETUP_DOWNLOAD) download_qr_create(screen, 74);
    if (page == QDD_SETUP_USB_DOWNLOAD) label(&s_usb_note, screen, 14, 207, 196, "", &qdd_cjk_14, MUTED, false);
    if (page == QDD_SETUP_HELP) {
        lv_obj_add_event_cb(screen, guide_device_draw, LV_EVENT_DRAW_MAIN, NULL);
        fixed_label(screen, 58, 128, 54, "设备", &qdd_cjk_20, 0xF58C6C, true);
        const int ys[] = {87, 130, 176};
        const char *names[] = {"上", "下", "确认"}, *actions[] = {"上移", "下移", "执行"};
        for (unsigned i = 0; i < 3; i++) {
            fixed_label(screen, 168, ys[i], 42, names[i], &qdd_cjk_14, INK, false);
            fixed_label(screen, 168, ys[i] + 19, 42, actions[i], &qdd_cjk_14, MUTED, false);
        }
    }
}
void qdd_ui_wifi(const qdd_setup_model_t *setup, qdd_wifi_view_t wifi) {
    if (wifi.connected && wifi.ip[0]) {
        if (s_onboarding_ip[0] && strcmp(s_onboarding_ip, wifi.ip) != 0) s_onboarding_complete = false;
        memcpy(s_onboarding_ip, wifi.ip, sizeof(s_onboarding_ip));
    }
    const bool wifi_unchanged = memcmp(&wifi, &s_wifi, sizeof(s_wifi)) == 0;
    s_wifi = wifi;
    if (setup->page != QDD_SETUP_LIST || !wifi.scanning) scan_activity(false);
    if (setup->page == QDD_SETUP_HOME) {
        s_cached = false; memset(&s_last_setup, 0, sizeof(s_last_setup));
        if (s_kind == SETUP) qdd_ui_create();
        return;
    }
    const unsigned length = (unsigned)strlen(setup->credentials.password);
    qdd_setup_model_t visible = *setup;
    memset(&visible.credentials, 0, sizeof(visible.credentials));
    memcpy(visible.credentials.ssid, setup->credentials.ssid, sizeof(visible.credentials.ssid));
    if (s_kind == SETUP && s_cached && length == s_last_length && memcmp(&visible, &s_last_setup, sizeof(visible)) == 0 && wifi_unchanged) return;
    if (s_kind != SETUP || s_setup_page != setup->page) setup_create(setup->page);
    s_last_setup = visible; s_last_length = length; s_cached = true;
    const bool keyboard = setup->page == QDD_SETUP_PASSWORD;
    if (s_keyboard) { if (keyboard) lv_obj_remove_flag(s_keyboard, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(s_keyboard, LV_OBJ_FLAG_HIDDEN); }
    for (unsigned i = 0; i < 5; i++) if (s_rows[i].object) lv_obj_add_flag(s_rows[i].object, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_y(s_hint.object, keyboard ? 241 : 290); lv_obj_set_y(s_notice.object, keyboard ? 272 : 74);
    char value[96], title[64]; const uint8_t empty_bssid[6] = {0}; text(&s_notice, "");
    if (setup->page == QDD_SETUP_LIST) {
        if (wifi.scanning) {
            text(&s_header, "正在扫描 Wi-Fi"); text(&s_detail, ""); text(&s_value, "请稍候");
            text(&s_hint, "确认返回 · 扫描继续");
            lv_obj_remove_flag(s_rows[4].object, LV_OBJ_FLAG_HIDDEN); text(&s_rows[4], "返回上一级");
            lv_obj_set_style_bg_color(s_rows[4].object, lv_color_hex(ACCENT), 0);
            scan_activity(true); return;
        }
        // Back remains on the last page rather than jumping to page one.
        const unsigned visible = setup->selection < wifi.count + 1u ? setup->selection : wifi.count;
        snprintf(title, sizeof(title), "连接无线网 %u/%u", visible / QDD_SETUP_VISIBLE_ROWS + 1,
            (wifi.count + QDD_SETUP_VISIBLE_ROWS) / QDD_SETUP_VISIBLE_ROWS);
        snprintf(value, sizeof(value), "共%u个网络 · 上下翻页", wifi.count);
        text(&s_header, title); text(&s_detail, value); text(&s_value, "");
    } else if (keyboard || setup->page == QDD_SETUP_ACTIONS) {
        if (keyboard) snprintf(title, sizeof(title), "输入密码 %u/4", qdd_setup_keyboard_page(setup) + 1); else strcpy(title, "完成输入");
        text(&s_header, title); ssid_display(value, sizeof(value), setup->credentials.ssid, 1, empty_bssid, 196); text(&s_detail, value);
        snprintf(value, sizeof(value), "密码 %.*s %u/64", length > 8 ? 8 : (int)length, "********", length); text(&s_value, value);
        if (keyboard) {
            text(&s_hint, setup->choosing_column ? "上下选字 · 确认输入" : "上下选行 · 确认选字");
            text(&s_notice, setup->error ? setup->error : "长按确认：完成/返回");
            s_keyboard_model.row = setup->row; s_keyboard_model.column = setup->column;
            s_keyboard_model.choosing_column = setup->choosing_column; s_keyboard_model.page = setup->page;
            lv_obj_invalidate(s_keyboard); return;
        }
    } else if (setup->page == QDD_SETUP_MENU) {
        text(&s_header, "设备设置"); text(&s_detail, "上下选择，确认进入"); text(&s_value, "");
    } else if (setup->page == QDD_SETUP_USB_DOWNLOAD) {
        text(&s_header, "USB备用下载"); s_usb_cached = false; usb_refresh(false); text(&s_hint, "确认返回");
        lv_obj_remove_flag(s_rows[4].object, LV_OBJ_FLAG_HIDDEN); text(&s_rows[4], "返回设置");
        lv_obj_set_style_bg_color(s_rows[4].object, lv_color_hex(ACCENT), 0); return;
    } else if (setup->page == QDD_SETUP_DOWNLOAD) {
        text(&s_header, "驱动下载"); text(&s_detail, "扫码或电脑打开下方网址");
        lv_obj_set_style_text_align(s_value.object, LV_TEXT_ALIGN_CENTER, 0);
        if (wifi.connected && wifi.ip[0]) {
            if (download_qr_update(wifi.ip)) lv_obj_remove_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN);
            else lv_obj_add_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN);
            lv_obj_set_y(s_value.object, 207); snprintf(value, sizeof(value), "%s:3334", wifi.ip); text(&s_value, value);
        } else {
            lv_obj_add_flag(s_qrcode, LV_OBJ_FLAG_HIDDEN); s_qr_url[0] = '\0';
            lv_obj_set_y(s_value.object, 131); text(&s_value, "请先连接无线网");
        }
        lv_obj_set_y(s_notice.object, 229); text(&s_notice, "手机也连接同一无线网");
        text(&s_hint, "确认返回");
        lv_obj_remove_flag(s_rows[4].object, LV_OBJ_FLAG_HIDDEN); text(&s_rows[4], "返回设置");
        lv_obj_set_style_bg_color(s_rows[4].object, lv_color_hex(ACCENT), 0); return;
    } else if (setup->page == QDD_SETUP_RESET) {
        text(&s_header, "重置设备"); text(&s_detail, "清除已保存的设备数据");
        text(&s_value, "Wi-Fi、蓝牙配对、引导记录");
        lv_obj_set_y(s_notice.object, 112); text(&s_notice, setup->error ? setup->error : "完成后重新进入连接引导");
        text(&s_hint, "确认执行 · 手机需重新配对");
        static const char *items[] = {"返回上一级", "清除并重新开始"};
        for (unsigned i = 0; i < 2; i++) {
            lv_obj_set_y(s_rows[i].object, 174 + (int)i * 39);
            lv_obj_remove_flag(s_rows[i].object, LV_OBJ_FLAG_HIDDEN); text(&s_rows[i], items[i]);
            lv_obj_set_style_bg_color(s_rows[i].object, lv_color_hex(setup->selection == i ? ACCENT : PANEL), 0);
        }
        return;
    } else if (setup->page == QDD_SETUP_HELP) {
        text(&s_header, "按键指南"); text(&s_detail, "实体按键位于机身右侧"); text(&s_value, "");
        text(&s_hint, setup->intro_to_onboarding ? "确认开始连接" : "确认返回");
        lv_obj_remove_flag(s_rows[4].object, LV_OBJ_FLAG_HIDDEN);
        text(&s_rows[4], setup->intro_to_onboarding ? "开始连接" : "返回上一级");
        lv_obj_set_style_bg_color(s_rows[4].object, lv_color_hex(ACCENT), 0); return;
    } else if (setup->page == QDD_SETUP_PAIR) {
        text(&s_header, "手机蓝牙"); text(&s_detail, "在手机蓝牙中选择"); text(&s_value, qdd_ble_name());
    } else {
        const bool scan_error = setup->page == QDD_SETUP_ERROR && !setup->credentials.ssid[0];
        text(&s_header, setup->page == QDD_SETUP_CONNECTING ? "正在连接" : scan_error ? "未能查找网络" : "未能连接");
        if (scan_error) value[0] = '\0';
        else ssid_display(value, sizeof(value), setup->credentials.ssid, 1, empty_bssid, 196);
        text(&s_detail, value);
        text(&s_value, setup->page == QDD_SETUP_CONNECTING ? "等待网络回应" : ""); text(&s_notice, setup->error ? setup->error : "");
    }
    text(&s_hint, setup->page == QDD_SETUP_ACTIONS && setup->error ? setup->error : "上下选择 · 确认进入");
    unsigned regular = 0, selected = setup->selection;
    if (setup->page == QDD_SETUP_MENU) regular = QDD_SETUP_MENU_ITEMS - 1;
    else if (setup->page == QDD_SETUP_ACTIONS) regular = QDD_SETUP_ACTION_COUNT - 1;
    else if (setup->page == QDD_SETUP_LIST) regular = wifi.count + 1;
    else if (setup->page == QDD_SETUP_ERROR || setup->page == QDD_SETUP_PAIR) regular = 1;
    if (setup->page == QDD_SETUP_ACTIONS) selected = setup->action_index;
    if (setup->page == QDD_SETUP_CONNECTING) selected = 0;
    const unsigned visible_index = selected < regular ? selected : regular ? regular - 1 : 0;
    const unsigned start = visible_index / QDD_SETUP_VISIBLE_ROWS * QDD_SETUP_VISIBLE_ROWS;
    if (s_menu_more) {
        if (start + QDD_SETUP_VISIBLE_ROWS < regular) lv_obj_remove_flag(s_menu_more, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_add_flag(s_menu_more, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_menu_previous) {
        if (start) lv_obj_remove_flag(s_menu_previous, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_add_flag(s_menu_previous, LV_OBJ_FLAG_HIDDEN);
    }
    for (unsigned i = 0; i < 4; i++) {
        const unsigned index = start + i; value[0] = '\0'; if (index >= regular) continue;
        if (setup->page == QDD_SETUP_MENU) {
            static const char *items[] = {
                [QDD_SETUP_MENU_WIFI] = "连接无线网", [QDD_SETUP_MENU_PAIR] = "手机蓝牙配对",
                [QDD_SETUP_MENU_DOWNLOAD] = "驱动下载", [QDD_SETUP_MENU_HELP] = "按键指南",
                [QDD_SETUP_MENU_RESET] = "重置设备"
            };
            _Static_assert(sizeof(items) / sizeof(items[0]) == QDD_SETUP_MENU_ITEMS - 1, "Settings labels must match navigation");
            strcpy(value, items[index]);
        }
        else if (setup->page == QDD_SETUP_ACTIONS) { static const char *items[] = {"连接网络", "继续输入", "删除一位", "清空密码"}; strcpy(value, items[index]); }
        else if (setup->page == QDD_SETUP_LIST) {
            if (index < wifi.count) {
                qdd_wifi_ap_t ap;
                if (qdd_wifi_ap((uint8_t)index, wifi.scan_revision, &ap)) ssid_display(value, sizeof(value), ap.ssid, index + 1, ap.bssid, 192);
                else strcpy(value, "正在更新网络");
            } else strcpy(value, "重新查找网络");
        } else strcpy(value, setup->page == QDD_SETUP_ERROR ?
            (setup->credentials.ssid[0] ? "重新输入密码" : "返回网络列表") : "开启手机配对");
        lv_obj_set_y(s_rows[i].object, setup->page == QDD_SETUP_PAIR || setup->page == QDD_SETUP_ERROR ? 139 + (int)i * 35 : 108 + (int)i * 35);
        lv_obj_remove_flag(s_rows[i].object, LV_OBJ_FLAG_HIDDEN); text(&s_rows[i], value);
        lv_obj_set_style_bg_color(s_rows[i].object, lv_color_hex(index == selected ? ACCENT : PANEL), 0);
    }
    lv_obj_remove_flag(s_rows[4].object, LV_OBJ_FLAG_HIDDEN); text(&s_rows[4], setup->page == QDD_SETUP_MENU ? "返回主界面" : "返回上一级");
    lv_obj_set_style_bg_color(s_rows[4].object, lv_color_hex(selected == regular ? ACCENT : PANEL), 0);
}
