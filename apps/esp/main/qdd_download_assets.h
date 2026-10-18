#pragma once

#include "esp_err.h"
#include "esp_partition.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define QDD_DOWNLOAD_ASSET_HEADER_SIZE 4096u
#define QDD_DOWNLOAD_ASSET_CHUNK_SIZE 2048u

typedef enum { QDD_DOWNLOAD_EXE = 0, QDD_DOWNLOAD_ZIP = 1 } qdd_download_kind_t;

typedef struct {
    const esp_partition_t *partition;
    const uint8_t *embedded;
    uint32_t size;
    qdd_download_kind_t kind;
    char sha256[65];
} qdd_download_asset_t;

// Nonblocking admission shared by HTTP and the offline USB session. The
// successful claimant releases exactly once after its task/session finishes.
bool qdd_download_assets_claim(void);
void qdd_download_assets_release(void);

// Successful admission claimant only. Validate the immutable EXE/ZIP in bounded chunks
// before sending any successful response. Prefer an existing assets partition;
// only its absence selects the immutable embedded ZIP. Invalid partition data
// never silently falls back to a different version. Neither source is decompressed.
// Caller supplies the same staging buffer subsequently used for HTTP sends.
esp_err_t qdd_download_assets_open(qdd_download_asset_t *asset, bool (*cancelled)(void),
    void *staging, size_t capacity);
esp_err_t qdd_download_assets_read(const qdd_download_asset_t *asset,
    size_t offset, void *buffer, size_t length);
