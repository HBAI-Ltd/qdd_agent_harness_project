#pragma once

#include "esp_err.h"
#include "qdd_onboarding_model.h"

// Starts a dedicated low-priority network worker. No HID or LVGL state is changed.
// Call once after qdd_wifi_start(); safe to call again after success.
esp_err_t qdd_onboarding_start(void);

// Bounded snapshot for presentation; registrations never authorize phone input.
qdd_onboarding_view_t qdd_onboarding_view(void);

// Coherent numeric-only snapshot, <256 bytes, no newline or input effect.
// Shared by HTTP and neutral USB DOWNLOAD_DIAG; 0/empty on insufficient capacity.
size_t qdd_onboarding_download_diagnostics(char *out, size_t capacity);
