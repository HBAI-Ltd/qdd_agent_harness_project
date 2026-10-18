#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define QDD_DRIVER_LINE_MAX 128u
#define QDD_DRIVER_READ_MAX 1024u
#define QDD_DRIVER_FRAME_MAX 2304u
#define QDD_DRIVER_ASSET_MAX 2093056u

typedef enum {
    QDD_DRIVER_NONE, QDD_DRIVER_INFO, QDD_DRIVER_READ, QDD_DRIVER_CANCEL
} qdd_driver_op_t;

typedef struct {
    uint32_t id, offset;
    uint16_t length;
    char session[17];
    qdd_driver_op_t operation;
} qdd_driver_command_t;

// Input excludes the LF already consumed by the bounded USB line assembler.
// On failure, retain a valid request id when one was parsed, for BAD_COMMAND.
bool qdd_driver_parse(const char *line, qdd_driver_command_t *command);
uint32_t qdd_driver_crc32(const uint8_t *bytes, size_t length);

// Return the complete frame length, including LF, excluding the terminating NUL.
// Invalid fields or insufficient capacity return zero and clear out[0].
size_t qdd_driver_format_info(char *out, size_t capacity, uint32_t id,
    const char *session, uint32_t size, const char *sha256);
size_t qdd_driver_format_data(char *out, size_t capacity, uint32_t id,
    const char *session, uint32_t offset, const uint8_t *bytes, size_t length);
size_t qdd_driver_format_ok(char *out, size_t capacity, uint32_t id);
// Error ids may be zero when a malformed request had no usable id.
size_t qdd_driver_format_error(char *out, size_t capacity, uint32_t id,
    const char *error);
