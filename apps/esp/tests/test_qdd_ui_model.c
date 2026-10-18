#include "qdd_ui_model.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static qdd_ui_view_t view(qdd_hid_state_t *state, bool usb) {
    return qdd_ui_model(state, usb, false, false, 0, 2000, "", 0);
}

static bool report(uint8_t id, const uint8_t *data, size_t size, void *context) {
    (void)id; (void)data; (void)size; (void)context;
    return true;
}

static void test_wifi_precedes_usb_and_connected_wifi_does_not_skip_usb(void) {
    qdd_hid_state_t state = {0};
    qdd_ui_onboarding_t progress = {.require_full = true};
    qdd_ui_view_t guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 1 && guide.stage == QDD_UI_WIFI);
    assert(strcmp(guide.title, "连接无线网") == 0 && !guide.show_qr && !guide.can_skip);
    progress.wifi_connected = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 2 && guide.stage == QDD_UI_USB_INSTALL);
    assert(strcmp(guide.title, "下载电脑软件") == 0 && !guide.show_qr);
    progress.pc_fresh = progress.phone_seen = progress.phone_fresh = progress.projecting = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 2); // Network/device observation cannot claim installation.
    progress.skip_desktop = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 4);
    progress.wifi_connected = false;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 1 && !guide.can_skip);
    assert(!state.armed && !state.heartbeat_seen);
}

static void test_pairing_settings_feedback(void) {
    qdd_ui_pairing_view_t pair = qdd_ui_pairing_model(false, false, false, true, false, 0, 1000, "PAIRING", 1000);
    assert(strcmp(pair.detail, "配对已开启，等待手机") == 0);
    assert(strcmp(pair.action, "重新开启配对") == 0 && strcmp(pair.notice, "配对已重新开启") == 0);
    assert(pair.flash_feedback && !pair.show_passkey);
    pair = qdd_ui_pairing_model(false, false, false, true, false, 0, 4000, "PAIRING", 1000);
    assert(strcmp(pair.notice, "手机蓝牙中选择本设备") == 0 && !pair.flash_feedback);
    pair = qdd_ui_pairing_model(false, false, false, true, false, 0, 4000, "PAIRING", 4000);
    assert(pair.flash_feedback && strcmp(pair.notice, "配对已重新开启") == 0);
    pair = qdd_ui_pairing_model(true, false, false, true, true, 123, 4000, "", 0);
    assert(pair.show_passkey && strcmp(pair.detail, "请在手机输入配对码") == 0);
    pair = qdd_ui_pairing_model(true, true, false, true, true, 123, 4000, "", 0);
    assert(!pair.show_passkey && !pair.flash_feedback && strcmp(pair.detail, "手机已连接") == 0);
    assert(strcmp(pair.notice, "正在准备键盘鼠标") == 0);
    pair = qdd_ui_pairing_model(true, true, true, true, true, 123, 4000, "", 0);
    assert(!pair.show_passkey && strcmp(pair.notice, "可以返回继续连接电脑") == 0);
    pair = qdd_ui_pairing_model(true, true, true, true, true, 123, 4000, "PAIRING", 4000);
    assert(!pair.show_passkey && pair.flash_feedback && strcmp(pair.detail, "手机已连接") == 0);
    assert(strcmp(pair.notice, "配对已重新开启") == 0); // Secure phones still get a visible click acknowledgement.
    pair = qdd_ui_pairing_model(false, false, false, false, true, 123, 4000, "PAIRING", 4000);
    assert(!pair.show_passkey && !pair.flash_feedback && strcmp(pair.detail, "配对窗口已关闭") == 0);
    assert(strcmp(pair.action, "开启手机配对") == 0); // Feedback cannot fake an open window.
    pair = qdd_ui_pairing_model(false, false, false, true, true, 1000000, 4000, "", 0);
    assert(!pair.show_passkey);
    pair = qdd_ui_pairing_model(false, false, false, true, false, 0, 4000, "PAIRING", 4001);
    assert(!pair.flash_feedback && strcmp(pair.notice, "手机蓝牙中选择本设备") == 0);
}

static void test_guide_actions_and_skip_safety(void) {
    for (unsigned step = 1; step <= 5; step++) {
        for (unsigned selected = 0; selected < 2; selected++) {
            for (unsigned locked = 0; locked < 2; locked++) {
                const qdd_ui_home_action_t action = qdd_ui_home_action(step, selected, locked != 0);
                assert(action != QDD_UI_HOME_STOP && action != QDD_UI_HOME_UNLOCK);
            }
        }
        assert(qdd_ui_home_choices(step) == 1u);
    }
    assert(qdd_ui_home_action(1, 0, false) == QDD_UI_HOME_WIFI_SETUP);
    assert(qdd_ui_home_action(2, 0, false) == QDD_UI_HOME_NEXT);
    assert(qdd_ui_home_action(2, 1, false) == QDD_UI_HOME_NEXT);
    assert(qdd_ui_home_action(1, 1, false) == QDD_UI_HOME_WIFI_SETUP);
    assert(qdd_ui_home_action(3, 0, false) == QDD_UI_HOME_NEXT);
    assert(qdd_ui_home_action(4, 0, false) == QDD_UI_HOME_PAIR);
    assert(qdd_ui_home_action(0, 0, false) == QDD_UI_HOME_STOP);
    assert(qdd_ui_home_action(0, 0, true) == QDD_UI_HOME_UNLOCK);
    assert(qdd_ui_home_action(0, 1, true) == QDD_UI_HOME_SETTINGS);
    qdd_hid_state_t state = {0};
    qdd_ui_onboarding_t progress = {.require_full = true, .skip_desktop = true, .wifi_connected = true};
    qdd_ui_view_t guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 3 && guide.can_skip && guide.show_qr);
    progress.skip_app = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 4 && guide.can_skip && !guide.show_qr);
    progress.skip_bluetooth = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 5 && !guide.can_skip && !guide.wait_projection && !guide.show_qr);
    state.heartbeat_seen = true;
    state.last_ping_ms = 1900;
    const qdd_hid_state_t before = state;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_PHONE && !guide.phone_secure);
    assert(memcmp(&state, &before, sizeof(state)) == 0 && !state.connected && !state.ready && !state.armed);
    const qdd_command_t move = {.id = 1, .op = QDD_MOVE, .args = {1, 0, 0, 0}};
    assert(strcmp(qdd_hid_execute(&state, &move, 2000, report, NULL), "NOT_CONNECTED") == 0);
    assert(!state.armed); // UI skips cannot authorize a real HID report.
    state.locked = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.stage == QDD_UI_LOCKED && !guide.can_skip && !guide.onboarding_step);
    state.locked = false;
    progress.skip_app = progress.skip_bluetooth = false; // RAM reset/configuration restores normal setup.
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 3 && guide.can_skip && guide.show_qr);
    progress.phone_seen = progress.phone_fresh = progress.projecting = true;
    progress.skip_bluetooth = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_PHONE);
}

static void test_completed_guide_preserves_real_status(void) {
    qdd_hid_state_t state = {.connected = true, .encrypted = true, .authenticated = true, .bonded = true,
        .ready = true, .heartbeat_seen = true, .last_ping_ms = 1900};
    qdd_ui_onboarding_t progress = {.require_full = true, .skip_desktop = true, .wifi_connected = true, .phone_seen = true,
        .phone_fresh = true, .projecting = true, .completed = true};
    qdd_ui_view_t guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_ENABLED && guide.computer_online);
    state.last_ping_ms = 0;
    const qdd_hid_state_t expired = state;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_COMPUTER && !guide.computer_online);
    assert(strcmp(guide.computer, "电脑未连接") == 0 && !guide.show_qr && !guide.can_skip);
    assert(memcmp(&state, &expired, sizeof(state)) == 0); // No fake lease extension.
    const qdd_command_t move = {.id = 1, .op = QDD_MOVE, .args = {1, 0, 0, 0}};
    assert(strcmp(qdd_hid_execute(&state, &move, 2000, report, NULL), "HEARTBEAT_EXPIRED") == 0);
    assert(!state.armed);
    progress.wifi_connected = progress.phone_fresh = progress.projecting = false;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_COMPUTER && !guide.computer_online);
    state.last_ping_ms = 1900;
    state.connected = false;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_PHONE && !guide.phone_secure);
    state.locked = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &progress);
    assert(guide.stage == QDD_UI_LOCKED && !guide.onboarding_step);
    state.locked = false;
    progress.completed = false; // An explicit reset or actual new LAN reopens setup.
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 1 && guide.stage == QDD_UI_WIFI);
}

static void test_pc_registration_is_visible_without_a_control_lease(void) {
    qdd_hid_state_t state = {.connected = true, .encrypted = true, .authenticated = true,
        .bonded = true, .ready = true};
    qdd_ui_onboarding_t progress = {.require_full = true, .skip_desktop = true, .wifi_connected = true,
        .phone_seen = true, .phone_fresh = true, .projecting = true};
    const qdd_hid_state_t before = state;
    // The operation console registers before control: observation sends no PING.
    progress.pc_fresh = true;
    qdd_ui_view_t guide = qdd_ui_onboarding_model(&state, false, false, false, 0,
        2000, "", 0, &progress);
    assert(guide.computer_online && strcmp(guide.computer, "电脑已连接") == 0);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_ENABLED);
    assert(memcmp(&before, &state, sizeof(state)) == 0);
    const qdd_command_t move = {.id = 1, .op = QDD_MOVE, .args = {1, 0, 0, 0}};
    assert(strcmp(qdd_hid_execute(&state, &move, 2000, report, NULL), "HEARTBEAT_EXPIRED") == 0);
    assert(!state.armed && !state.heartbeat_seen); // Presentation never grants input.
    progress.completed = true;
    progress.pc_fresh = false;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(!guide.computer_online && guide.stage == QDD_UI_COMPUTER);
    progress.pc_fresh = true;
    state.locked = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.computer_online && guide.stage == QDD_UI_LOCKED && !guide.onboarding_step);
    state.locked = false;
    progress.completed = false;
    progress.phone_seen = progress.phone_fresh = progress.projecting = false;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 3 && guide.show_qr); // PC alone does not fake phone setup.
}

static void test_completed_guide_reports_projection_loss_without_restarting_setup(void) {
    qdd_hid_state_t state = {.connected = true, .encrypted = true, .authenticated = true,
        .bonded = true, .ready = true};
    qdd_ui_onboarding_t progress = {.require_full = true, .skip_desktop = true, .wifi_connected = true,
        .phone_seen = true, .phone_fresh = true, .pc_fresh = true, .projecting = false, .completed = true};
    const qdd_hid_state_t before = state;
    qdd_ui_view_t guide = qdd_ui_onboarding_model(&state, false, false, false, 0,
        2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && !guide.show_qr && !guide.can_skip);
    assert(guide.wait_projection && guide.stage != QDD_UI_ENABLED);
    assert(strcmp(guide.title, "分享手机画面") == 0);
    progress.phone_fresh = false;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.wait_projection);
    assert(strcmp(guide.title, "打开手机投屏") == 0);
    progress.phone_fresh = progress.projecting = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_ENABLED && !guide.wait_projection);
    assert(memcmp(&before, &state, sizeof(state)) == 0);
    progress.projecting = false;
    progress.skip_app = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(!guide.wait_projection); // The explicit skip remains a presentation choice.
    progress.skip_app = false;
    state.locked = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.stage == QDD_UI_LOCKED && !guide.wait_projection);
    state.locked = false;
    progress.pc_fresh = false;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(guide.stage == QDD_UI_COMPUTER && !guide.wait_projection);
}


static void test_explicit_pages_preserve_evidence(void) {
    qdd_hid_state_t state = {0};
    qdd_ui_onboarding_t progress = {.require_full = true, .page = 1};
    assert(qdd_ui_guide_target(1, false) == 1);
    assert(qdd_ui_guide_target(6, true) == 7);
    assert(qdd_ui_guide_target(0, true) == 0);
    assert(qdd_ui_guide_target(7, false) == 7);
    for (unsigned page = 1; page <= 6; page++) {
        progress.page = page;
        const qdd_hid_state_t before = state;
        const qdd_ui_onboarding_t evidence = progress;
        qdd_ui_view_t current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
        assert(current.onboarding_step == page && !current.show_qr && !current.can_skip);
        assert(current.stage != QDD_UI_ENABLED);
        assert(memcmp(&before, &state, sizeof(state)) == 0);
        assert(memcmp(&evidence, &progress, sizeof(progress)) == 0);
        if (page > 1) assert(qdd_ui_guide_target(page, false) == page - 1);
    }
    progress.page = 1; progress.wifi_connected = true;
    qdd_ui_view_t current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(current.onboarding_step == 1); // Connection changes cannot jump to downloads.
    progress.page = 3;
    current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(current.show_qr && current.onboarding_step == 3);
    progress.phone_seen = progress.phone_fresh = progress.projecting = progress.pc_fresh = true;
    state.connected = state.encrypted = state.bonded = state.ready = true;
    state.authenticated = false; // Just Works remains encrypted and bonded, without a MITM claim.
    current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(current.onboarding_step == 3 && current.phone_secure && !state.authenticated);
    progress.page = 6;
    current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(current.onboarding_step == 6 && current.stage == QDD_UI_ENABLED);
    progress.phone_fresh = false;
    current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(current.onboarding_step == 6 && current.stage != QDD_UI_ENABLED);
    progress.page = 0; progress.completed = true; progress.phone_seen = false;
    current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(current.stage != QDD_UI_ENABLED); // Finishing instructions is not readiness.
    state.encrypted = false; progress.page = 4;
    current = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &progress);
    assert(!current.phone_secure && !state.armed);
}

int main(void) {
    test_explicit_pages_preserve_evidence();
    test_wifi_precedes_usb_and_connected_wifi_does_not_skip_usb();
    test_pairing_settings_feedback();
    test_guide_actions_and_skip_safety();
    test_completed_guide_preserves_real_status();
    test_pc_registration_is_visible_without_a_control_lease();
    test_completed_guide_reports_projection_loss_without_restarting_setup();
    qdd_hid_state_t state = {0};
    assert(view(&state, false).stage == QDD_UI_COMPUTER);
    assert(strcmp(view(&state, true).computer, "电脑未连接") == 0);
    state.heartbeat_seen = true;
    state.last_ping_ms = 500;
    assert(view(&state, true).computer_online); // Inclusive lease boundary.
    state.last_ping_ms = 499;
    assert(!view(&state, true).computer_online);
    state.last_ping_ms = 2001;
    assert(!view(&state, true).computer_online); // Clock anomalies fail closed.
    state.last_ping_ms = 1900;
    assert(view(&state, true).stage == QDD_UI_PHONE);
    state.connected = true;
    state.encrypted = true;
    state.bonded = true;
    assert(view(&state, true).stage == QDD_UI_HID); // Just Works encryption plus bonding; no MITM claim.
    state.authenticated = true;
    assert(view(&state, true).stage == QDD_UI_HID);
    state.ready = true;
    assert(view(&state, true).stage == QDD_UI_ENABLED);
    assert(strcmp(view(&state, true).title, "可以远程操作") == 0);
    state.armed = true;
    assert(view(&state, true).stage == QDD_UI_ENABLED);
    assert(view(&state, false).stage == QDD_UI_COMPUTER);
    state.locked = true;
    assert(view(&state, false).stage == QDD_UI_LOCKED);
    assert(strcmp(view(&state, false).next, "选择取消急停并确认") == 0);
    const qdd_hid_state_t before = state;
    (void)qdd_ui_model(&state, true, true, true, 123, 2000, "LOCKED", 1990);
    assert(memcmp(&state, &before, sizeof(state)) == 0); // UI never arms or clears a lock.

    assert(!qdd_ui_model(&state, true, false, true, 123, 2000, "", 0).show_passkey);
    assert(!qdd_ui_model(&state, true, true, false, 123, 2000, "", 0).show_passkey);
    assert(!qdd_ui_model(&state, true, true, true, 1000000, 2000, "", 0).show_passkey);
    assert(qdd_ui_model(&state, true, true, true, 0, 2000, "", 0).show_passkey);
    assert(qdd_ui_model(&state, true, true, true, 999999, 2000, "", 0).show_passkey);
    assert(strcmp(qdd_ui_model(&state, true, false, false, 0, 2000, "HEARTBEAT_EXPIRED", 1000).notice,
                  "请先启动电脑操作台") == 0);
    assert(!*qdd_ui_model(&state, true, false, false, 0, 4000, "ENABLED", 1000).notice);
    assert(!*qdd_ui_model(&state, true, false, false, 0, 2000, "ENABLED", 2001).notice);
    assert(strcmp(qdd_ui_model(&state, true, false, false, 0, 2000, "UNKNOWN", 1990).notice,
                  "操作未完成，请重试") == 0);

    // Confirm only unlocks. The next fresh, secure input works without ARM.
    state.armed = false;
    qdd_hid_unlock(&state);
    assert(!state.armed && !state.locked);
    const qdd_command_t move = {.id = 1, .op = QDD_MOVE, .args = {1, 0, 0, 0}};
    assert(qdd_hid_execute(&state, &move, 2000, report, NULL) == NULL);
    assert(state.armed && !state.locked);
    qdd_hid_pause(&state, true);
    qdd_hid_unlock(&state);
    state.last_ping_ms = 0;
    assert(strcmp(qdd_hid_execute(&state, &move, 2000, report, NULL), "HEARTBEAT_EXPIRED") == 0);
    assert(!state.armed && !state.locked);
    // First connection advances by observed capabilities, never by a UI ARM.
    state = (qdd_hid_state_t){0};
    qdd_ui_onboarding_t onboarding = {0};
    qdd_ui_view_t guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 1 && guide.stage == QDD_UI_WIFI && !guide.show_qr);
    onboarding.wifi_connected = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 2 && guide.stage == QDD_UI_USB_INSTALL && !guide.show_qr);
    onboarding.skip_desktop = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 3 && guide.show_qr);
    onboarding.downloaded = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 3 && guide.show_qr);
    onboarding.phone_seen = onboarding.phone_fresh = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 4 && guide.stage == QDD_UI_PHONE && !guide.show_qr);
    onboarding.phone_fresh = false; // App heartbeat expires while system Bluetooth settings are open.
    guide = qdd_ui_onboarding_model(&state, false, true, true, 123456, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 4 && guide.stage == QDD_UI_PHONE && !guide.show_qr && guide.show_passkey);
    state.connected = state.encrypted = state.authenticated = state.bonded = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 4 && guide.stage == QDD_UI_HID);
    state.ready = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 5 && guide.wait_projection && !guide.show_qr);
    assert(strcmp(guide.title, "打开手机投屏") == 0 && strcmp(guide.detail, "返回App恢复连接") == 0);
    onboarding.phone_fresh = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 5 && strcmp(guide.title, "分享手机画面") == 0);
    onboarding.projecting = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 5); // Raw transport or /api/pc registration is not a fresh PING.
    state.heartbeat_seen = true; state.last_ping_ms = 1900;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_ENABLED);
    assert(!state.armed); // The guide never needs a separate enable state.
    onboarding.phone_fresh = false;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 5 && guide.wait_projection && !guide.show_qr);
    // Stale projecting=true must never let the guide claim remote control is ready.
    assert(strcmp(guide.title, "打开手机投屏") == 0);
    onboarding.wifi_connected = false;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 1 && !guide.show_qr);
    onboarding.wifi_connected = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 5 && !guide.show_qr);
    state.connected = state.ready = false; // Re-pairing never restarts installation.
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 4 && !guide.show_qr);
    state.connected = state.ready = true;
    onboarding.phone_fresh = true;
    onboarding.projecting = false; // The user stopped projection.
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 5 && guide.wait_projection && !guide.show_qr);
    onboarding.projecting = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 6 && guide.stage == QDD_UI_ENABLED);
    onboarding = (qdd_ui_onboarding_t){0};
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 6); // Existing installations skip the wizard.
    onboarding.require_full = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 1); // Fresh/reset boards never take the legacy bypass.
    onboarding.wifi_connected = true;
    onboarding.skip_desktop = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 3 && guide.show_qr);
    onboarding.phone_seen = onboarding.phone_fresh = onboarding.projecting = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 6); // New onboarding still completes normally.

    state.locked = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.stage == QDD_UI_LOCKED && guide.onboarding_step == 0 && !guide.show_qr);
    puts("QDD Chinese UI priority, lease, pairing privacy and unlock-policy tests: PASS");
    return 0;
}
