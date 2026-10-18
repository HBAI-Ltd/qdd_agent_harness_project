#include "qdd_ui_model.h"
#include <string.h>

unsigned qdd_ui_home_choices(unsigned guide_step) {
    return guide_step ? 1u : 2u;
}

unsigned qdd_ui_guide_target(unsigned page, bool forward) {
    if (page < 1 || page > 6) return page;
    return forward ? page + 1 : page > 1 ? page - 1 : 1;
}

qdd_ui_home_action_t qdd_ui_home_action(unsigned guide_step, unsigned selection, bool locked) {
    if (guide_step) {
        if (guide_step == 1) return QDD_UI_HOME_WIFI_SETUP;
        if (guide_step == 4) return QDD_UI_HOME_PAIR;
        return QDD_UI_HOME_NEXT;
    }
    if (selection == 1) return QDD_UI_HOME_SETTINGS;
    return locked ? QDD_UI_HOME_UNLOCK : QDD_UI_HOME_STOP;
}

qdd_ui_pairing_view_t qdd_ui_pairing_model(bool connected, bool secure, bool ready,
    bool pairing_open, bool passkey_visible, uint32_t passkey,
    uint64_t now_ms, const char *feedback, uint64_t feedback_ms) {
    const bool fresh_feedback = pairing_open && feedback && strcmp(feedback, "PAIRING") == 0 &&
        now_ms >= feedback_ms && now_ms - feedback_ms < QDD_UI_NOTICE_MS;
    qdd_ui_pairing_view_t view = {.action = pairing_open ? "重新开启配对" : "开启手机配对"};
    if (connected && secure) {
        view.detail = "手机已连接";
        view.notice = ready ? "可以返回继续连接电脑" : "正在准备键盘鼠标";
    } else if (pairing_open && passkey_visible && passkey <= 999999) {
        view.show_passkey = true;
        view.detail = "请在手机输入配对码";
        view.notice = "按手机提示完成配对";
    } else if (connected) {
        view.detail = "手机配对中";
        view.notice = "请按手机提示完成配对";
    } else if (pairing_open) {
        view.detail = "配对已开启，等待手机";
        view.notice = fresh_feedback ? "配对已重新开启" : "手机蓝牙中选择本设备";
    } else {
        view.detail = "配对窗口已关闭";
        view.notice = "确认开启手机配对";
    }
    if (fresh_feedback) view.notice = "配对已重新开启";
    view.flash_feedback = fresh_feedback && now_ms - feedback_ms < 600u;
    return view;
}

static const char *notice(const char *feedback) {
    if (!feedback || !*feedback) return "";
    static const struct { const char *code; const char *text; } notes[] = {
        {"PHYSICAL_STOP", "已紧急停止"},
        {"UNLOCKED", "急停已解除"},
        {"ENABLED", "现在可以操作手机"},
        {"PAIRING", "配对窗口已打开两分钟"},
        {"USB_REPLY_FAILED", "电脑通信已断开"},
        {"LOCKED", "选择取消急停并确认"},
        {"NOT_CONNECTED", "手机蓝牙尚未连接"},
        {"NOT_AUTHENTICATED", "请先完成手机安全配对"},
        {"HID_NOT_READY", "手机仍在连接，请稍候"},
        {"HEARTBEAT_EXPIRED", "请先启动电脑操作台"},
        {"HID_SEND_FAILED", "手机操作未送达"},
        {"BAD_COMMAND", "电脑指令格式错误"},
        {"LINE_TOO_LONG", "电脑指令过长"},
        {"STARTUP_FAILED", "设备初始化失败"},
        {"CONTROL_BUSY", "另一台电脑正在连接"},
        {"CONFIGURING", "正在设置网络"},
        {"WIFI_FAILED", "网络连接失败，可用数据线"},
        {"WIFI_CONNECTED", "网络已连接，等待电脑"},
    };
    for (size_t i = 0; i < sizeof(notes) / sizeof(notes[0]); i++) {
        if (strcmp(feedback, notes[i].code) == 0) return notes[i].text;
    }
    return "操作未完成，请重试";
}

static bool controller_online(const qdd_hid_state_t *state, bool transport_live, uint64_t now_ms) {
    return transport_live && state->heartbeat_seen && now_ms >= state->last_ping_ms &&
        now_ms - state->last_ping_ms <= QDD_HEARTBEAT_MS;
}

static qdd_ui_view_t status_model(const qdd_hid_state_t *state, bool computer_online,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms) {
    qdd_ui_view_t view = {0};
    view.computer_online = computer_online;
    view.phone_secure = state->connected && state->encrypted && state->bonded;
    view.computer = view.computer_online ? "电脑已连接" : "电脑未连接";
    view.phone = view.phone_secure ? "手机已连接" :
        state->connected ? "手机配对中" : state->bonded ? "手机未连接" : "手机未配对";
    view.accent = 0xF58C6C;
    view.confirm = "上下选设置，确认进入";
    view.show_passkey = pairing_open && passkey_visible && passkey <= 999999;
    view.pairing = view.show_passkey ? "请在手机输入配对码" :
        pairing_open ? "请在手机蓝牙中选择" : "手机蓝牙名称";
    view.notice = now_ms >= feedback_ms && now_ms - feedback_ms < QDD_UI_NOTICE_MS ? notice(feedback) : "";

    if (state->locked) {
        view.stage = QDD_UI_LOCKED;
        view.accent = 0xFF9B87;
        view.title = "已紧急停止";
        view.detail = "手机操作已经停止";
        view.next = "选择取消急停并确认";
    } else if (!view.computer_online) {
        view.stage = QDD_UI_COMPUTER;
        view.title = "等待电脑连接";
        view.detail = "先连接Wi-Fi或电脑数据线";
        view.next = "再打开电脑操作台";
    } else if (!view.phone_secure) {
        view.stage = QDD_UI_PHONE;
        view.title = state->bonded && !state->connected ? "等待手机连接" : "请先配对手机";
        view.detail = state->bonded && !state->connected ? "请打开手机蓝牙" : "在手机蓝牙中选择本设备";
        view.next = pairing_open ? "配对窗口已打开" : "设置中选择手机蓝牙配对";
    } else if (!state->ready) {
        view.stage = QDD_UI_HID;
        view.title = "手机连接中";
        view.detail = "手机正在准备接收操作";
        view.next = "请稍候";
    } else {
        view.stage = QDD_UI_ENABLED;
        view.accent = 0x93DDB8;
        view.title = "可以远程操作";
        view.detail = "点击电脑画面即可操作";
        view.next = "按Esc退出遥控";
    }
    return view;
}

qdd_ui_view_t qdd_ui_model(const qdd_hid_state_t *state, bool usb_connected,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms) {
    return status_model(state, controller_online(state, usb_connected, now_ms),
        pairing_open, passkey_visible, passkey, now_ms, feedback, feedback_ms);
}

static void projection_view(qdd_ui_view_t *view, bool phone_fresh) {
    view->stage = QDD_UI_COMPUTER;
    view->wait_projection = true;
    view->title = phone_fresh ? "分享手机画面" : "打开手机投屏";
    view->detail = phone_fresh ? "手机App点开始投屏" : "返回App恢复连接";
    view->next = phone_fresh ? "同意共享后启动电脑" : "连接后点开始投屏";
}

static void instruction_page(qdd_ui_view_t *view, unsigned page,
    const qdd_hid_state_t *state, const qdd_ui_onboarding_t *progress, bool pairing_open) {
    view->onboarding_step = page;
    view->show_qr = false;
    view->can_skip = false;
    switch (page) {
    case 1:
        view->stage = QDD_UI_WIFI;
        view->title = "连接无线网";
        view->detail = progress->wifi_connected ? "网络已连接" : "按确认选择无线网";
        view->next = "电脑和手机连同一无线网";
        break;
    case 2:
        view->stage = QDD_UI_USB_INSTALL;
        view->title = "下载电脑软件";
        view->detail = "电脑浏览器打开下方网址";
        view->next = progress->wifi_connected ? "点击电脑下载，解压后打开" : "先返回第一步连接无线网";
        break;
    case 3:
        view->stage = progress->downloaded ? QDD_UI_INSTALL : QDD_UI_DOWNLOAD;
        view->show_qr = progress->wifi_connected;
        view->title = "安装手机软件";
        view->detail = progress->phone_seen ? "手机App已连接" : "手机扫码下载并安装";
        view->next = progress->wifi_connected ? "手机也连接同一无线网" : "先返回第一步连接无线网";
        break;
    case 4:
        view->stage = view->phone_secure ? QDD_UI_HID : QDD_UI_PHONE;
        view->title = "连接手机蓝牙";
        view->detail = view->phone_secure ? (state->ready ? "手机蓝牙已连接" : "手机连接中，请稍候") :
            pairing_open ? "手机蓝牙中选择本设备" : "按确认开启配对";
        view->next = "手机确认配对，无需输数字";
        break;
    case 5:
        projection_view(view, progress->phone_fresh);
        view->next = "再打开电脑设备操作台";
        break;
    case 6:
        if (view->stage == QDD_UI_ENABLED && (!progress->phone_fresh || !progress->projecting))
            projection_view(view, progress->phone_fresh);
        view->next = "可返回检查，或进入主界面";
        break;
    }
}

qdd_ui_view_t qdd_ui_onboarding_model(const qdd_hid_state_t *state, bool computer_live,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms,
                          const qdd_ui_onboarding_t *onboarding) {
    // The console registers before it claims HID control. Show that real,
    // bounded registration without modifying the control lease or HID state.
    qdd_ui_view_t view = status_model(state,
        onboarding->pc_fresh || controller_online(state, computer_live, now_ms),
        pairing_open, passkey_visible, passkey, now_ms, feedback, feedback_ms);
    if (state->locked) return view;
    if (onboarding->page >= 1 && onboarding->page <= 6) {
        instruction_page(&view, onboarding->page, state, onboarding, pairing_open);
        return view;
    }
    if (onboarding->completed) {
        view.onboarding_step = 6;
        if (view.stage == QDD_UI_ENABLED && (onboarding->phone_seen || onboarding->require_full) && !onboarding->skip_app &&
            (!onboarding->phone_fresh || !onboarding->projecting)) {
            projection_view(&view, onboarding->phone_fresh);
        }
        return view; // Real link/lease state remains visible on the normal page.
    }
    // A working earlier installation remains usable without repeating setup.
    // Once the new App registers, its projection state controls the guide.
    if (!onboarding->require_full && !onboarding->phone_seen && view.computer_online && view.phone_secure && state->ready) {
        view.onboarding_step = 6;
        return view;
    }
    if (!onboarding->wifi_connected) {
        view.stage = QDD_UI_WIFI;
        view.onboarding_step = 1;
        view.title = "连接无线网";
        view.detail = "按确认选择无线网";
        view.next = "电脑和手机连同一无线网";
    } else if (!onboarding->skip_desktop) {
        view.stage = QDD_UI_USB_INSTALL;
        view.onboarding_step = 2;
        view.title = "下载电脑软件";
        view.detail = "电脑浏览器打开下方网址";
        view.next = "可稍后安装并继续";
    } else if (!onboarding->phone_seen && !onboarding->skip_app) {
        view.stage = onboarding->downloaded ? QDD_UI_INSTALL : QDD_UI_DOWNLOAD;
        view.onboarding_step = 3;
        view.show_qr = true;
        view.title = view.stage == QDD_UI_DOWNLOAD ? "手机扫码安装" : "打开手机投屏";
        view.detail = view.stage == QDD_UI_DOWNLOAD ? "下载并安装投屏App" : "安装后打开投屏App";
        view.next = "手机也连接同一无线网";
    } else if ((!view.phone_secure || !state->ready) && !onboarding->skip_bluetooth) {
        view.stage = view.phone_secure ? QDD_UI_HID : QDD_UI_PHONE;
        view.onboarding_step = 4;
        view.title = view.phone_secure ? "蓝牙连接中" : "连接手机蓝牙";
        view.detail = view.phone_secure ? "手机正在准备键盘鼠标" : "在手机蓝牙中选择";
        view.next = view.phone_secure ? "请稍候" : pairing_open ? "按手机提示完成配对" : "设置中选择手机蓝牙配对";
    } else if ((!onboarding->phone_fresh || !onboarding->projecting) && !onboarding->skip_app) {
        projection_view(&view, onboarding->phone_fresh);
        view.onboarding_step = 5;
    } else if (!view.computer_online) {
        view.stage = QDD_UI_COMPUTER;
        view.onboarding_step = 5;
        view.title = "连接电脑操作台";
        view.detail = "电脑打开设备操作台";
        view.next = "自动找到手机和控制板";
    } else {
        view.onboarding_step = 6;
        // Skipping is a presentation choice, never proof of a usable link.
        if (onboarding->skip_app || onboarding->skip_bluetooth) return view;
        view.stage = QDD_UI_ENABLED;
        view.accent = 0x93DDB8;
        view.title = "可以远程操作";
        view.detail = "电脑点击画面就能操作";
        view.next = "按Esc退出远程操作";
    }
    view.can_skip = view.onboarding_step == 3 || view.onboarding_step == 4;
    return view;
}
