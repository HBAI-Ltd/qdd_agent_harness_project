#pragma once

#include "qdd_hid.h"

#define QDD_UI_WIDTH 240
#define QDD_UI_HEIGHT 320
#define QDD_UI_NOTICE_MS 3000u

typedef enum {
    QDD_UI_LOCKED, QDD_UI_COMPUTER, QDD_UI_PHONE, QDD_UI_HID,
    QDD_UI_ENABLED, QDD_UI_WIFI, QDD_UI_DOWNLOAD, QDD_UI_INSTALL
} qdd_ui_stage_t;

typedef struct {
    qdd_ui_stage_t stage;
    bool computer_online;
    bool phone_secure;
    bool show_passkey;
    uint32_t accent;
    const char *computer;
    const char *phone;
    const char *title;
    const char *detail;
    const char *next;
    const char *pairing;
    const char *notice;
    const char *confirm;
    unsigned onboarding_step;
    bool show_qr;
    bool wait_projection;
} qdd_ui_view_t;

typedef struct {
    bool require_full;
    bool wifi_connected;
    bool downloaded;
    bool phone_seen;
    bool phone_fresh;
    bool projecting;
} qdd_ui_onboarding_t;

// Presentation only: never changes the HID state or authorizes input.
qdd_ui_view_t qdd_ui_model(const qdd_hid_state_t *state, bool usb_connected,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms);

qdd_ui_view_t qdd_ui_onboarding_model(const qdd_hid_state_t *state, bool computer_live,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms,
                          const qdd_ui_onboarding_t *onboarding);
