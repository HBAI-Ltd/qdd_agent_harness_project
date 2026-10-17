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

int main(void) {
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
    assert(view(&state, true).stage == QDD_UI_PHONE); // Encryption is not MITM authentication.
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
    assert(guide.onboarding_step == 2 && guide.show_qr);
    onboarding.downloaded = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 3 && guide.show_qr);
    onboarding.phone_seen = onboarding.phone_fresh = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 4 && guide.stage == QDD_UI_PHONE && !guide.show_qr);
    state.connected = state.encrypted = state.authenticated = state.bonded = true;
    guide = qdd_ui_onboarding_model(&state, false, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 4 && guide.stage == QDD_UI_HID);
    state.ready = true;
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
    assert(guide.onboarding_step == 3); // Lost App registration cannot revive legacy bypass.
    onboarding = (qdd_ui_onboarding_t){0};
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 6); // Existing installations skip the wizard.
    onboarding.require_full = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 1); // Fresh/reset boards never take the legacy bypass.
    onboarding.wifi_connected = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 2 && guide.show_qr);
    onboarding.phone_seen = onboarding.phone_fresh = onboarding.projecting = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.onboarding_step == 6); // New onboarding still completes normally.

    state.locked = true;
    guide = qdd_ui_onboarding_model(&state, true, false, false, 0, 2000, "", 0, &onboarding);
    assert(guide.stage == QDD_UI_LOCKED && guide.onboarding_step == 0 && !guide.show_qr);
    puts("QDD Chinese UI priority, lease, pairing privacy and unlock-policy tests: PASS");
    return 0;
}
