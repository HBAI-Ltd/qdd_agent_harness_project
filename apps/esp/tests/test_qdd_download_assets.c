#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../main/qdd_download_assets.c"

static esp_partition_t partition = {.size = 16384};
static uint8_t flash[16384];
static bool missing, fail_read, bad_sha, fail_sha_start, fail_sha_update, fail_sha_finish;
static unsigned reads, yields, freed;
static size_t max_read;
static const size_t payload_size = 9000;
static uint8_t staging[QDD_DOWNLOAD_ASSET_CHUNK_SIZE];
static void *first_payload_buffer;
uint8_t qdd_test_desktop_zip[QDD_DESKTOP_ZIP_SIZE];
size_t qdd_test_desktop_zip_length;

static void put32(size_t offset, uint32_t value) {
    for (unsigned i = 0; i < 4; i++) flash[offset + i] = (uint8_t)(value >> (i * 8));
}
static void reset(void) {
    memset(flash, 0, sizeof(flash));
    memset(qdd_test_desktop_zip, 0x5a, sizeof(qdd_test_desktop_zip));
    memcpy(qdd_test_desktop_zip, "PK\003\004", 4);
    qdd_test_desktop_zip_length = sizeof(qdd_test_desktop_zip);
    memcpy(flash, "QDDDRV1\0", 8);
    put32(8, 1); put32(12, 4096); put32(16, payload_size);
    memset(flash + 24, 0xab, 32);
    flash[4096] = 'M'; flash[4097] = 'Z';
    missing = fail_read = bad_sha = fail_sha_start = fail_sha_update = fail_sha_finish = false;
    reads = yields = freed = 0; max_read = 0; first_payload_buffer = NULL;
}
const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label) {
    assert(type == ESP_PARTITION_TYPE_DATA && subtype == ESP_PARTITION_SUBTYPE_ANY && !strcmp(label, "assets"));
    return missing ? NULL : &partition;
}
esp_err_t esp_partition_read(const esp_partition_t *part, size_t offset, void *buffer, size_t length) {
    assert(part == &partition && offset <= sizeof(flash) && length <= sizeof(flash) - offset);
    assert(length <= QDD_DOWNLOAD_ASSET_CHUNK_SIZE);
    if (offset >= 4096 && !first_payload_buffer) first_payload_buffer = buffer;
    reads++; if (length > max_read) max_read = length;
    if (fail_read) return ESP_FAIL;
    memcpy(buffer, flash + offset, length); return ESP_OK;
}
void qdd_test_yield(void) { yields++; }
void mbedtls_sha256_init(mbedtls_sha256_context *sha) { sha->bytes = 0; }
int mbedtls_sha256_starts(mbedtls_sha256_context *sha, int is224) {
    assert(!sha->bytes && !is224); return fail_sha_start ? -1 : 0;
}
int mbedtls_sha256_update(mbedtls_sha256_context *sha, const unsigned char *bytes, size_t length) {
    assert(bytes == staging && length && length <= 2048);
    if (missing) assert(!memcmp(bytes, qdd_test_desktop_zip + sha->bytes, length));
    sha->bytes += length; return fail_sha_update ? -1 : 0;
}
int mbedtls_sha256_finish(mbedtls_sha256_context *sha, unsigned char digest[32]) {
    assert(sha->bytes == payload_size); memset(digest, bad_sha ? 0xcd : 0xab, 32);
    return fail_sha_finish ? -1 : 0;
}
void mbedtls_sha256_free(mbedtls_sha256_context *sha) { assert(sha); freed++; }

static void test_valid_and_bounded_reads(void) {
    reset(); qdd_download_asset_t asset;
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_OK);
    assert(asset.partition == &partition && !asset.embedded && asset.size == payload_size);
    assert(asset.kind == QDD_DOWNLOAD_EXE);
    assert(strlen(asset.sha256) == 64 && !strncmp(asset.sha256, "abababab", 8));
    assert(first_payload_buffer == staging);
    assert(reads == 6 && max_read == 2048 && yields == 5 && freed == 1);
    uint8_t bytes[2048];
    assert(qdd_download_assets_read(&asset, 0, bytes, sizeof(bytes)) == ESP_OK && bytes[0] == 'M');
    assert(qdd_download_assets_read(&asset, payload_size - 1, bytes, 1) == ESP_OK);
    assert(qdd_download_assets_read(&asset, payload_size, bytes, 1) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, SIZE_MAX, bytes, 1) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, 0, bytes, 2049) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, 0, bytes, 0) == ESP_FAIL);
    assert(qdd_download_assets_read(NULL, 0, bytes, 1) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, 0, NULL, 1) == ESP_FAIL);
}
static bool cancel_mid_validation(void) { return reads >= 3; }
static bool cancel_embedded_validation(void) { return yields >= 2; }

static void test_embedded_fallback(void) {
    reset(); missing = true; qdd_download_asset_t asset;
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_OK);
    assert(!asset.partition && asset.embedded == qdd_test_desktop_zip);
    assert(asset.size == sizeof(qdd_test_desktop_zip) && asset.kind == QDD_DOWNLOAD_ZIP);
    assert(reads == 0 && yields == 5 && freed == 1);
    uint8_t bytes[2048];
    for (size_t offset = 0; offset < asset.size;) {
        size_t length = asset.size - offset;
        if (length > sizeof(bytes)) length = sizeof(bytes);
        assert(qdd_download_assets_read(&asset, offset, bytes, length) == ESP_OK);
        assert(!memcmp(bytes, qdd_test_desktop_zip + offset, length));
        offset += length;
    }
    assert(qdd_download_assets_read(&asset, asset.size, bytes, 1) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, SIZE_MAX, bytes, 1) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, 0, bytes, 2049) == ESP_FAIL);
    assert(qdd_download_assets_read(&asset, 0, bytes, 0) == ESP_FAIL);
    asset.embedded++;
    assert(qdd_download_assets_read(&asset, 0, bytes, 1) == ESP_FAIL);
    asset.embedded = qdd_test_desktop_zip; asset.size--;
    assert(qdd_download_assets_read(&asset, 0, bytes, 1) == ESP_FAIL);

    reset(); missing = true; bad_sha = true;
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    assert(!asset.partition && !asset.embedded && !asset.size && freed == 1);
    reset(); missing = true; qdd_test_desktop_zip[0] = 0;
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    assert(!asset.embedded && !asset.size && freed == 1);
    reset(); missing = true;
    assert(qdd_download_assets_open(&asset, cancel_embedded_validation, staging, sizeof(staging)) == ESP_FAIL);
    assert(!asset.embedded && !asset.size && reads == 0 && yields == 2 && freed == 1);
    reset(); missing = true; qdd_test_desktop_zip_length--;
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    assert(!asset.embedded && !asset.size && freed == 0);
}

static void test_zip_resource(void) {
    reset(); qdd_download_asset_t asset;
    memcpy(flash, "QDDDRV2\0", 8); put32(8, 2); put32(20, 1);
    memcpy(flash + 4096, "PK\003\004", 4);
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_OK);
    assert(asset.size == payload_size && first_payload_buffer == staging && max_read <= 2048);
    assert(asset.kind == QDD_DOWNLOAD_ZIP);
    uint8_t bytes[4];
    assert(qdd_download_assets_read(&asset, 0, bytes, sizeof(bytes)) == ESP_OK && !memcmp(bytes, "PK\003\004", 4));
    flash[4096] = 'M'; flash[4097] = 'Z';
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && !asset.partition);
    reset(); memcpy(flash + 4096, "PK\003\004", 4);
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    const uint32_t wrong_versions[] = {0, 1, 3, UINT32_MAX};
    for (size_t i = 0; i < sizeof(wrong_versions) / sizeof(wrong_versions[0]); i++) {
        reset(); memcpy(flash, "QDDDRV2\0", 8); put32(8, wrong_versions[i]); put32(20, 1);
        memcpy(flash + 4096, "PK\003\004", 4);
        assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    }
    reset(); memcpy(flash, "QDDDRV2\0", 8); put32(8, 2); put32(20, 2);
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
}

static void test_rejections(void) {
    qdd_download_asset_t asset;
    const size_t positions[] = {0, 8, 12, 20, 56, 60};
    for (size_t i = 0; i < sizeof(positions) / sizeof(positions[0]); i++) {
        reset(); flash[positions[i]] ^= 1;
        assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && !asset.partition && !asset.embedded && !asset.size);
    }
    reset(); put32(16, 1); assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    reset(); put32(16, UINT32_MAX); assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    reset(); fail_read = true; assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL);
    reset(); flash[4096] = 0; assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && freed == 1);
    reset(); bad_sha = true; assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && freed == 1);
    reset(); fail_sha_start = true; assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && freed == 1);
    reset(); fail_sha_update = true; assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && freed == 1);
    reset(); fail_sha_finish = true; assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)) == ESP_FAIL && freed == 1);
    reset(); assert(qdd_download_assets_open(&asset, cancel_mid_validation, staging, sizeof(staging)) == ESP_FAIL && freed == 1 && reads == 3);
    reset(); assert(qdd_download_assets_open(&asset, NULL, NULL, sizeof(staging)) == ESP_FAIL);
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)-1) == ESP_FAIL);
    assert(qdd_download_assets_open(&asset, NULL, staging, sizeof(staging)+1) == ESP_FAIL);
    assert(qdd_download_assets_open(NULL, NULL, staging, sizeof(staging)) == ESP_FAIL);
}
int main(void) {
    assert(qdd_download_assets_claim());
    assert(!qdd_download_assets_claim());
    qdd_download_assets_release();
    assert(qdd_download_assets_claim());
    qdd_download_assets_release();
    test_valid_and_bounded_reads(); test_zip_resource(); test_embedded_fallback(); test_rejections();
    puts("QDD assets and missing-partition embedded fallback, bounded reads, digest failures and range guards: PASS");
    return 0;
}
