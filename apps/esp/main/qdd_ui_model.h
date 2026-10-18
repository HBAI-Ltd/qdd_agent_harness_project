#pragma once

#include "qdd_hid.h"

#define QDD_UI_WIDTH 240
#define QDD_UI_HEIGHT 320
#define QDD_UI_NOTICE_MS 3000u

typedef enum {
    QDD_UI_LOCKED, QDD_UI_COMPUTER, QDD_UI_PHONE, QDD_UI_HID,
    QDD_UI_ENABLED, QDD_UI_WIFI, QDD_UI_DOWNLOAD, QDD_UI_INSTALL, QDD_UI_USB_INSTALL
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
    bool can_skip;
} qdd_ui_view_t;

typedef struct {
    bool require_full;
    bool wifi_connected;
    bool downloaded;
    bool phone_seen;
    bool phone_fresh;
    bool pc_fresh;
    bool projecting;
    bool skip_desktop;
    bool skip_app;
    bool skip_bluetooth;
    bool completed;
    // Explicitly selected instruction page; zero preserves legacy routing.
    unsigned page;
} qdd_ui_onboarding_t;

typedef enum {
    QDD_UI_HOME_STOP, QDD_UI_HOME_UNLOCK, QDD_UI_HOME_SETTINGS,
    QDD_UI_HOME_SKIP_APP, QDD_UI_HOME_SKIP_BLUETOOTH,
    QDD_UI_HOME_DESKTOP_READY, QDD_UI_HOME_WIFI_SETUP,
    QDD_UI_HOME_NEXT, QDD_UI_HOME_PAIR
} qdd_ui_home_action_t;

unsigned qdd_ui_home_choices(unsigned guide_step);
// Pages 1..6; 7 means explicitly leaving the instructions, not link readiness.
unsigned qdd_ui_guide_target(unsigned page, bool forward);
qdd_ui_home_action_t qdd_ui_home_action(unsigned guide_step, unsigned selection, bool locked);

typedef struct {
    const char *detail;
    const char *notice;
    const char *action;
    bool show_passkey;
    bool flash_feedback;
} qdd_ui_pairing_view_t;

qdd_ui_pairing_view_t qdd_ui_pairing_model(bool connected, bool secure, bool ready,
    bool pairing_open, bool passkey_visible, uint32_t passkey,
    uint64_t now_ms, const char *feedback, uint64_t feedback_ms);

// Presentation only: never changes the HID state or authorizes input.
qdd_ui_view_t qdd_ui_model(const qdd_hid_state_t *state, bool usb_connected,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms);

qdd_ui_view_t qdd_ui_onboarding_model(const qdd_hid_state_t *state, bool computer_live,
                          bool pairing_open, bool passkey_visible, uint32_t passkey,
                          uint64_t now_ms, const char *feedback, uint64_t feedback_ms,
                          const qdd_ui_onboarding_t *onboarding);
