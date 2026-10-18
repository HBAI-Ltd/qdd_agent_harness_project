#pragma once
#include <stddef.h>
#include <stdint.h>
typedef struct { size_t bytes; } mbedtls_sha256_context;
void mbedtls_sha256_init(mbedtls_sha256_context *context);
int mbedtls_sha256_starts(mbedtls_sha256_context *context, int is224);
int mbedtls_sha256_update(mbedtls_sha256_context *context, const unsigned char *bytes, size_t length);
int mbedtls_sha256_finish(mbedtls_sha256_context *context, unsigned char digest[32]);
void mbedtls_sha256_free(mbedtls_sha256_context *context);
