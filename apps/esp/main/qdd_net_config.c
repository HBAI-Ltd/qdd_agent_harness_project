#include "qdd_net_config.h"
#include "qdd_hid.h"
#include <string.h>

static int sextet(char value) {
    if (value >= 'A' && value <= 'Z') return value - 'A';
    if (value >= 'a' && value <= 'z') return value - 'a' + 26;
    if (value >= '0' && value <= '9') return value - '0' + 52;
    return value == '+' ? 62 : value == '/' ? 63 : -1;
}

static bool decode(const char *text, uint8_t *out, size_t capacity, size_t *length) {
    *length = 0;
    if (strcmp(text, "-") == 0) return true;
    const size_t size = strlen(text);
    if (!size || size % 4) return false;
    for (size_t i = 0; i < size; i += 4) {
        int a = sextet(text[i]), b = sextet(text[i + 1]);
        int c = text[i + 2] == '=' ? 0 : sextet(text[i + 2]);
        int d = text[i + 3] == '=' ? 0 : sextet(text[i + 3]);
        const bool pad2 = text[i + 2] == '=', pad1 = text[i + 3] == '=';
        if (a < 0 || b < 0 || c < 0 || d < 0 || (pad2 && !pad1) ||
            ((pad1 || pad2) && i + 4 != size) || (pad2 && (b & 15)) ||
            (pad1 && !pad2 && (c & 3))) return false;
        const uint8_t bytes[] = {(uint8_t)((a << 2) | (b >> 4)),
            (uint8_t)((b << 4) | (c >> 2)), (uint8_t)((c << 6) | d)};
        const size_t count = pad2 ? 1 : pad1 ? 2 : 3;
        if (*length + count >= capacity) return false;
        for (size_t j = 0; j < count; j++) {
            if (!bytes[j]) return false;
            out[(*length)++] = bytes[j];
        }
    }
    out[*length] = 0;
    return true;
}

bool qdd_net_parse(const char *line, qdd_net_command_t *command) {
    if (!line || strlen(line) > QDD_LINE_MAX) return false;
    memset(command, 0, sizeof(*command));
    if (strncmp(line, "QDDNET/1 ", 9) != 0) return false;
    const char *cursor = line + 9;
    uint32_t id = 0;
    if (*cursor < '0' || *cursor > '9') return false;
    while (*cursor >= '0' && *cursor <= '9') {
        const unsigned digit = (unsigned)(*cursor++ - '0');
        if (id > (2147483647u - digit) / 10u) return false;
        id = id * 10u + digit;
    }
    if (!id || *cursor++ != ' ') return false;
    command->id = id;
    static const struct { const char *name; qdd_net_operation_t operation; bool data; } operations[] = {
        {"WIFI_STATUS", QDD_NET_STATUS, false}, {"WIFI_SSID", QDD_NET_SSID, true},
        {"WIFI_DIAG", QDD_NET_DIAGNOSTICS, false},
        {"WIFI_PASS", QDD_NET_PASSWORD, true}, {"WIFI_SAVE", QDD_NET_SAVE, false},
        {"WIFI_CLEAR", QDD_NET_CLEAR, false}, {"WIFI_RETRY", QDD_NET_RETRY, false},
    };
    for (size_t i = 0; i < sizeof(operations) / sizeof(operations[0]); i++) {
        const size_t size = strlen(operations[i].name);
        if (strncmp(cursor, operations[i].name, size) != 0) continue;
        cursor += size;
        command->operation = operations[i].operation;
        if (!operations[i].data) return *cursor == 0;
        if (*cursor++ != ' ') return false;
        if (!decode(cursor, command->data, sizeof(command->data), &command->length)) return false;
        return command->operation == QDD_NET_SSID ? command->length > 0 && command->length <= 32 : command->length <= 64;
    }
    return false;
}

bool qdd_wifi_credentials_valid(const qdd_wifi_credentials_t *credentials) {
    if (!memchr(credentials->ssid, 0, sizeof(credentials->ssid)) ||
        !memchr(credentials->password, 0, sizeof(credentials->password))) return false;
    const size_t ssid = strlen(credentials->ssid), password = strlen(credentials->password);
    if (ssid == 0 || ssid > 32 || (password > 0 && password < 8) || password > 64) return false;
    if (password == 64) {
        for (size_t i = 0; i < password; i++) {
            const char value = credentials->password[i];
            if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') ||
                (value >= 'A' && value <= 'F'))) return false;
        }
    }
    return true;
}
