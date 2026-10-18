#pragma once

#include "qdd_ble.h"
#include "qdd_setup_model.h"
#include "qdd_wifi.h"
#include "qdd_driver_usb.h"

void qdd_ui_create(void);
void qdd_ui_require_onboarding(bool required);
void qdd_ui_onboarding_skips(bool desktop, bool app, bool bluetooth);
void qdd_ui_driver(qdd_driver_usb_view_t view);
unsigned qdd_ui_guide_step(void);
// Atomic navigation only; safe in the button callback, with no LVGL/I/O.
void qdd_ui_guide_navigate(bool forward);
void qdd_ui_home_selection(unsigned selection);
void qdd_ui_refresh(const qdd_hid_state_t *state, qdd_ble_status_t ble,
                     bool usb_connected, int battery, uint64_t now_ms,
                     const char *feedback, uint64_t feedback_ms);
void qdd_ui_wifi(const qdd_setup_model_t *setup, qdd_wifi_view_t wifi);
