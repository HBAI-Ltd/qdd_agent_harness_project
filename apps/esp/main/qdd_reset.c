#include "qdd_reset.h"

#include "nvs.h"
#include "nvs_flash.h"

esp_err_t qdd_reset_request(void) {
    nvs_handle_t handle;
    esp_err_t error = nvs_open("qdd_reset", NVS_READWRITE, &handle);
    if (error != ESP_OK) return error;
    error = nvs_set_u8(handle, "pending", 1);
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    return error;
}

esp_err_t qdd_reset_boot(bool *reset_applied) {
    if (!reset_applied) return ESP_ERR_INVALID_ARG;
    *reset_applied = false;
    esp_err_t error = nvs_flash_init();
    if (error != ESP_OK) return error;
    nvs_handle_t handle;
    error = nvs_open("qdd_reset", NVS_READONLY, &handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (error != ESP_OK) return error;
    uint8_t pending = 0;
    error = nvs_get_u8(handle, "pending", &pending);
    nvs_close(handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (error != ESP_OK) return error;
    if (pending == 0) return ESP_OK;
    if (pending != 1) return ESP_ERR_INVALID_STATE;
    // This intentionally clears every default-NVS namespace, including Wi-Fi,
    // NimBLE bonds and SDK configuration. Firmware, APK, PHY partition and
    // hardware identity are outside the NVS partition and remain untouched.
    error = nvs_flash_erase();
    if (error == ESP_OK) error = nvs_flash_init();
    if (error == ESP_OK) *reset_applied = true;
    return error;
}
