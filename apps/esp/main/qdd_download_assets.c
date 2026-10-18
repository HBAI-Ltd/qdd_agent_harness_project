#include "qdd_download_assets.h"
#include "qdd_desktop_zip.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include <stdbool.h>
#include <stdatomic.h>
#include <string.h>

static atomic_bool s_claimed;

#ifndef QDD_DESKTOP_ZIP_START
extern const uint8_t qdd_desktop_zip_start[] asm("_binary_qdd_desktop_zip_start");
extern const uint8_t qdd_desktop_zip_end[] asm("_binary_qdd_desktop_zip_end");
#define QDD_DESKTOP_ZIP_START qdd_desktop_zip_start
#define QDD_DESKTOP_ZIP_END qdd_desktop_zip_end
#endif

static const uint8_t s_embedded_sha256[32] = QDD_DESKTOP_ZIP_SHA256_BYTES;

static bool embedded_size_valid(void) {
    const uintptr_t start = (uintptr_t)QDD_DESKTOP_ZIP_START;
    const uintptr_t end = (uintptr_t)QDD_DESKTOP_ZIP_END;
    return end >= start && end - start == QDD_DESKTOP_ZIP_SIZE &&
        QDD_DESKTOP_ZIP_SIZE >= 64u && QDD_DESKTOP_ZIP_SIZE <= 1048576u;
}

static esp_err_t read_source(const esp_partition_t *partition, size_t offset,
    void *buffer, size_t length) {
    if (partition) return esp_partition_read(partition,
        QDD_DOWNLOAD_ASSET_HEADER_SIZE + offset, buffer, length);
    memcpy(buffer, QDD_DESKTOP_ZIP_START + offset, length);
    return ESP_OK;
}

bool qdd_download_assets_claim(void) {
    bool expected = false;
    return atomic_compare_exchange_strong(&s_claimed, &expected, true);
}

void qdd_download_assets_release(void) { atomic_store(&s_claimed, false); }

static uint32_t little_u32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 |
        (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

esp_err_t qdd_download_assets_open(qdd_download_asset_t *asset, bool (*cancelled)(void),
    void *staging, size_t capacity) {
    if (!asset) return ESP_FAIL;
    memset(asset, 0, sizeof(*asset));
    if (!staging || capacity != QDD_DOWNLOAD_ASSET_CHUNK_SIZE) return ESP_FAIL;
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "assets");
    uint8_t header[64];
    bool zipped = true;
    uint32_t length = QDD_DESKTOP_ZIP_SIZE;
    const uint8_t *expected_sha256 = s_embedded_sha256;
    if (partition) {
        if (partition->size <= QDD_DOWNLOAD_ASSET_HEADER_SIZE ||
            esp_partition_read(partition, 0, header, sizeof(header)) != ESP_OK ||
            little_u32(header + 12) != QDD_DOWNLOAD_ASSET_HEADER_SIZE ||
            little_u32(header + 56) != 0u ||
            little_u32(header + 60) != 0u) return ESP_FAIL;
        const bool raw = !memcmp(header, "QDDDRV1\0", 8) && little_u32(header + 8) == 1u && little_u32(header + 20) == 0u;
        zipped = !memcmp(header, "QDDDRV2\0", 8) && little_u32(header + 8) == 2u && little_u32(header + 20) == 1u;
        if (!raw && !zipped) return ESP_FAIL;
        length = little_u32(header + 16);
        if (length < 64u || length > partition->size - QDD_DOWNLOAD_ASSET_HEADER_SIZE) return ESP_FAIL;
        expected_sha256 = header + 24;
    } else if (!embedded_size_valid()) return ESP_FAIL;

    // Validation and transmission never overlap. Reuse the worker's single
    // 2 KiB staging buffer rather than permanently reserving a second copy.
    uint8_t *buffer = staging;
    uint8_t digest[32];
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    bool valid = mbedtls_sha256_starts(&sha, 0) == 0;
    for (size_t offset = 0; valid && offset < length;) {
        if (cancelled && cancelled()) { valid = false; break; }
        const size_t remaining = length - offset;
        const size_t portion = remaining < capacity ? remaining : capacity;
        valid = read_source(partition, offset, buffer, portion) == ESP_OK;
        if (valid && offset == 0) valid = zipped ? !memcmp(buffer, "PK\003\004", 4) : buffer[0] == 'M' && buffer[1] == 'Z';
        if (valid) valid = mbedtls_sha256_update(&sha, buffer, portion) == 0;
        offset += portion;
        taskYIELD();
    }
    if (valid && cancelled && cancelled()) valid = false;
    if (valid) valid = mbedtls_sha256_finish(&sha, digest) == 0 && memcmp(digest, expected_sha256, 32) == 0;
    mbedtls_sha256_free(&sha);
    if (!valid) return ESP_FAIL;
    asset->partition = partition;
    asset->embedded = partition ? NULL : QDD_DESKTOP_ZIP_START;
    asset->size = length;
    asset->kind = zipped ? QDD_DOWNLOAD_ZIP : QDD_DOWNLOAD_EXE;
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < sizeof(digest); i++) {
        asset->sha256[i * 2] = hex[digest[i] >> 4];
        asset->sha256[i * 2 + 1] = hex[digest[i] & 15];
    }
    asset->sha256[64] = 0;
    return ESP_OK;
}

esp_err_t qdd_download_assets_read(const qdd_download_asset_t *asset,
    size_t offset, void *buffer, size_t length) {
    if (!asset || !buffer || !length || length > QDD_DOWNLOAD_ASSET_CHUNK_SIZE ||
        offset > asset->size || length > asset->size - offset) return ESP_FAIL;
    if (asset->partition) {
        if (asset->embedded || asset->partition->size < QDD_DOWNLOAD_ASSET_HEADER_SIZE ||
            asset->size > asset->partition->size - QDD_DOWNLOAD_ASSET_HEADER_SIZE) return ESP_FAIL;
    } else if (asset->embedded != QDD_DESKTOP_ZIP_START ||
        asset->kind != QDD_DOWNLOAD_ZIP || asset->size != QDD_DESKTOP_ZIP_SIZE ||
        !embedded_size_valid()) return ESP_FAIL;
    return read_source(asset->partition, offset, buffer, length);
}
