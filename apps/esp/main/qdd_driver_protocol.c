#include "qdd_driver_protocol.h"

#include <stdio.h>
#include <string.h>

static bool clear_output(char *out, size_t capacity) {
    if (!out || !capacity) return false;
    out[0] = 0;
    return true;
}

static bool lower_hex(const char *text, size_t length, bool nonzero) {
    if (!text) return false;
    bool any = false;
    for (size_t i = 0; i < length; i++) {
        const char value = text[i];
        if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
        any = any || value != '0';
    }
    return text[length] == 0 && (!nonzero || any);
}

static bool decimal(const char **cursor, uint32_t *number) {
    const char *text = *cursor;
    if (*text < '0' || *text > '9') return false;
    uint32_t value = 0;
    do {
        const uint32_t digit = (uint32_t)(*text - '0');
        if (value > (UINT32_MAX - digit) / 10u) return false;
        value = value * 10u + digit;
        ++text;
    } while (*text >= '0' && *text <= '9');
    *cursor = text;
    *number = value;
    return true;
}

static bool session_token(const char **cursor, char session[17]) {
    const char *text = *cursor;
    bool nonzero = false;
    for (size_t i = 0; i < 16; i++) {
        const char value = text[i];
        if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
        nonzero = nonzero || value != '0';
    }
    if (!nonzero || (text[16] != ' ' && text[16] != 0)) return false;
    memcpy(session, text, 16);
    session[16] = 0;
    *cursor += 16;
    return true;
}

bool qdd_driver_parse(const char *line, qdd_driver_command_t *command) {
    if (!command) return false;
    memset(command, 0, sizeof(*command));
    if (!line) return false;
    size_t length = 0;
    while (length <= QDD_DRIVER_LINE_MAX && line[length]) ++length;
    if (length > QDD_DRIVER_LINE_MAX || strncmp(line, "QDDDRV/1 ", 9)) return false;
    const char *cursor = line + 9;
    uint32_t id = 0;
    if (!decimal(&cursor, &id) || !id || *cursor != ' ') return false;
    command->id = id;
    ++cursor;
    if (!strcmp(cursor, "INFO")) {
        command->operation = QDD_DRIVER_INFO;
        return true;
    }
    const bool read = !strncmp(cursor, "READ ", 5);
    const bool cancel = !strncmp(cursor, "CANCEL ", 7);
    if (!read && !cancel) return false;
    cursor += read ? 5 : 7;
    if (!session_token(&cursor, command->session)) return false;
    if (cancel) {
        if (*cursor) return false;
        command->operation = QDD_DRIVER_CANCEL;
        return true;
    }
    uint32_t offset = 0, count = 0;
    if (*cursor != ' ') return false;
    ++cursor;
    if (!decimal(&cursor, &offset) || *cursor != ' ') return false;
    ++cursor;
    if (!decimal(&cursor, &count) || *cursor || !count || count > QDD_DRIVER_READ_MAX) return false;
    command->offset = offset;
    command->length = (uint16_t)count;
    command->operation = QDD_DRIVER_READ;
    return true;
}

uint32_t qdd_driver_crc32(const uint8_t *bytes, size_t length) {
    if (!bytes && length) return 0;
    uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < length; i++) {
        crc ^= bytes[i];
        for (unsigned bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ ((crc & 1u) ? UINT32_C(0xedb88320) : 0u);
    }
    return crc ^ UINT32_MAX;
}

static size_t formatted(char *out, size_t capacity, int length) {
    if (length <= 0 || (size_t)length >= capacity) { out[0] = 0; return 0; }
    return (size_t)length;
}

size_t qdd_driver_format_info(char *out, size_t capacity, uint32_t id,
    const char *session, uint32_t size, const char *sha256) {
    if (!clear_output(out, capacity)) return 0;
    if (!id || !lower_hex(session, 16, true) || !size || size > QDD_DRIVER_ASSET_MAX ||
        !lower_hex(sha256, 64, false)) return 0;
    return formatted(out, capacity, snprintf(out, capacity, "QDDDRV/1 %lu INFO %s %lu %s ZIP\n",
        (unsigned long)id, session, (unsigned long)size, sha256));
}

size_t qdd_driver_format_data(char *out, size_t capacity, uint32_t id,
    const char *session, uint32_t offset, const uint8_t *bytes, size_t length) {
    if (!clear_output(out, capacity)) return 0;
    if (!id || !lower_hex(session, 16, true) || !bytes || !length || length > QDD_DRIVER_READ_MAX ||
        offset >= QDD_DRIVER_ASSET_MAX || length > QDD_DRIVER_ASSET_MAX - offset) return 0;
    const uint32_t crc = qdd_driver_crc32(bytes, length);
    const int header = snprintf(out, capacity, "QDDDRV/1 %lu DATA %s %lu %u %08lx ",
        (unsigned long)id, session, (unsigned long)offset, (unsigned)length, (unsigned long)crc);
    if (header <= 0 || (size_t)header >= capacity || length * 2u + 2u > capacity - (size_t)header) {
        out[0] = 0;
        return 0;
    }
    static const char hex[] = "0123456789abcdef";
    size_t position = (size_t)header;
    for (size_t i = 0; i < length; i++) {
        out[position++] = hex[bytes[i] >> 4];
        out[position++] = hex[bytes[i] & 15u];
    }
    out[position++] = '\n';
    out[position] = 0;
    return position;
}

size_t qdd_driver_format_ok(char *out, size_t capacity, uint32_t id) {
    if (!clear_output(out, capacity) || !id) return 0;
    return formatted(out, capacity, snprintf(out, capacity, "QDDDRV/1 %lu OK\n", (unsigned long)id));
}

size_t qdd_driver_format_error(char *out, size_t capacity, uint32_t id, const char *error) {
    if (!clear_output(out, capacity)) return 0;
    if (!error || *error < 'A' || *error > 'Z') return 0;
    size_t size = 0;
    while (error[size]) {
        const char value = error[size];
        if (++size > 32 || !((value >= 'A' && value <= 'Z') ||
            (value >= '0' && value <= '9') || value == '_')) return 0;
    }
    return formatted(out, capacity, snprintf(out, capacity, "QDDDRV/1 %lu ERR %s\n", (unsigned long)id, error));
}
