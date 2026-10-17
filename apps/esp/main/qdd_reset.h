#pragma once

#include "esp_err.h"
#include <stdbool.h>

// Run before starting BLE, Wi-Fi or any task that can persist configuration.
esp_err_t qdd_reset_boot(bool *reset_applied);

// Only the locally confirmed settings action may request a factory reset.
// Commit first, then reboot; the next boot erases NVS without live writers.
esp_err_t qdd_reset_request(void);
