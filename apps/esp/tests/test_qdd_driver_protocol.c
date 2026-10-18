#include "qdd_driver_protocol.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const char *SESSION = "0123456789abcdef";
static const char *SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

static void parse_commands(void) {
    qdd_driver_command_t command;
    assert(qdd_driver_parse("QDDDRV/1 1 INFO", &command));
    assert(command.id == 1 && command.operation == QDD_DRIVER_INFO);
    assert(command.offset == 0 && command.length == 0 && command.session[0] == 0);
    assert(qdd_driver_parse("QDDDRV/1 4294967295 READ 0123456789abcdef 2092032 1024", &command));
    assert(command.id == UINT32_MAX && command.operation == QDD_DRIVER_READ);
    assert(command.offset == QDD_DRIVER_ASSET_MAX - 1024 && command.length == 1024);
    assert(strcmp(command.session, SESSION) == 0);
    assert(qdd_driver_parse("QDDDRV/1 42 READ 0000000000000001 0 1", &command));
    assert(command.length == 1 && command.offset == 0);
    assert(qdd_driver_parse("QDDDRV/1 4 CANCEL 0123456789abcdef", &command));
    assert(command.operation == QDD_DRIVER_CANCEL && command.length == 0);

    const char *bad[] = {
        "QDDDRV/2 1 INFO", "QDDDRV/1 0 INFO", "QDDDRV/1 -1 INFO", "QDDDRV/1 +1 INFO",
        "QDDDRV/1 4294967296 INFO", "QDDDRV/1 99999999999999999999 INFO",
        "QDDDRV/1 1  INFO", "QDDDRV/1 1 INFO ", "QDDDRV/1 1 INFO extra",
        "QDDDRV/1 1 INFO\n", "QDDDRV/1 1 INFO\r", "QDDDRV/1 1\tINFO", " QDDDRV/1 1 INFO",
        "QDDDRV/1 1 READ 0000000000000000 0 1", "QDDDRV/1 1 READ 0123456789abcdeF 0 1",
        "QDDDRV/1 1 READ 0123456789abcdeg 0 1", "QDDDRV/1 1 READ 0123456789abcde 0 1",
        "QDDDRV/1 1 READ 0123456789abcdef0 0 1", "QDDDRV/1 1 READ 0123456789abcdef -1 1",
        "QDDDRV/1 1 READ 0123456789abcdef 4294967296 1",
        "QDDDRV/1 1 READ 0123456789abcdef 0 0", "QDDDRV/1 1 READ 0123456789abcdef 0 1025",
        "QDDDRV/1 1 READ 0123456789abcdef 0 4294967296",
        "QDDDRV/1 1 READ 0123456789abcdef 0 1 ", "QDDDRV/1 1 READ 0123456789abcdef 0 1 extra",
        "QDDDRV/1 1 READ 0123456789abcdef  0 1", "QDDDRV/1 1 READ 0123456789abcdef 0  1",
        "QDDDRV/1 1 CANCEL 0000000000000000", "QDDDRV/1 1 CANCEL 0123456789abcdef extra",
        "QDDDRV/1 1 CANCEL", "QDDDRV/1 1 READ", "QDDDRV/1 1 OTHER", "QDDDRV/1 1",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        assert(!qdd_driver_parse(bad[i], &command));
    }
    assert(!qdd_driver_parse("QDDDRV/1 123 READ wrong 0 1", &command) && command.id == 123);
    assert(!qdd_driver_parse("QDDDRV/1 456 UNKNOWN", &command) && command.id == 456);
    assert(!qdd_driver_parse(NULL, &command) && command.id == 0);
    assert(!qdd_driver_parse("QDDDRV/1 1 INFO", NULL));
    char oversized[QDD_DRIVER_LINE_MAX + 2];
    memset(oversized, 'A', sizeof(oversized));
    oversized[sizeof(oversized) - 1] = 0;
    assert(!qdd_driver_parse(oversized, &command));
}

static void format_frames(void) {
    char out[QDD_DRIVER_FRAME_MAX];
    char expected[256];
    size_t length = qdd_driver_format_info(out, sizeof(out), 9, SESSION, 943153, SHA);
    snprintf(expected, sizeof(expected), "QDDDRV/1 9 INFO %s 943153 %s ZIP\n", SESSION, SHA);
    assert(length == strlen(expected) && strcmp(out, expected) == 0);
    assert(qdd_driver_format_info(out, sizeof(out), 9, SESSION, QDD_DRIVER_ASSET_MAX, SHA));
    assert(!qdd_driver_format_info(out, sizeof(out), 0, SESSION, 943153, SHA) && !out[0]);
    assert(!qdd_driver_format_info(out, sizeof(out), 1, "0000000000000000", 943153, SHA));
    assert(!qdd_driver_format_info(out, sizeof(out), 1, SESSION, 0, SHA));
    assert(!qdd_driver_format_info(out, sizeof(out), 1, SESSION, QDD_DRIVER_ASSET_MAX + 1u, SHA));
    assert(!qdd_driver_format_info(out, sizeof(out), 1, SESSION, 943153, "ABC"));
    assert(!qdd_driver_format_info(out, sizeof(out), 1, SESSION, 943153, NULL));

    const uint8_t bytes[] = {0, 1, 2, 3, 255};
    assert(qdd_driver_crc32(NULL, 0) == 0);
    assert(qdd_driver_crc32((const uint8_t *)"123456789", 9) == UINT32_C(0xcbf43926));
    assert(qdd_driver_crc32((const uint8_t *)"The quick brown fox jumps over the lazy dog", 43) == UINT32_C(0x414fa339));
    assert(qdd_driver_crc32(bytes, sizeof(bytes)) == UINT32_C(0x7b35f858));
    length = qdd_driver_format_data(out, sizeof(out), UINT32_MAX, SESSION, 123, bytes, sizeof(bytes));
    snprintf(expected, sizeof(expected), "QDDDRV/1 4294967295 DATA %s 123 5 7b35f858 00010203ff\n", SESSION);
    assert(length == strlen(expected) && strcmp(out, expected) == 0);
    const size_t exact = length + 1;
    assert(qdd_driver_format_data(out, exact, UINT32_MAX, SESSION, 123, bytes, sizeof(bytes)) == length);
    assert(!qdd_driver_format_data(out, exact - 1, UINT32_MAX, SESSION, 123, bytes, sizeof(bytes)) && !out[0]);
    assert(!qdd_driver_format_data(out, sizeof(out), 1, SESSION, 0, bytes, 0));
    assert(!qdd_driver_format_data(out, sizeof(out), 1, SESSION, 0, NULL, 1));
    assert(!qdd_driver_format_data(out, sizeof(out), 1, SESSION, UINT32_MAX, bytes, 1));
    assert(!qdd_driver_format_data(out, sizeof(out), 1, SESSION, QDD_DRIVER_ASSET_MAX, bytes, 1));
    assert(!qdd_driver_format_data(out, sizeof(out), 1, SESSION, 0, bytes, QDD_DRIVER_READ_MAX + 1u));

    uint8_t block[QDD_DRIVER_READ_MAX];
    for (size_t i = 0; i < sizeof(block); i++) block[i] = (uint8_t)i;
    length = qdd_driver_format_data(out, sizeof(out), UINT32_MAX, SESSION,
        QDD_DRIVER_ASSET_MAX - sizeof(block), block, sizeof(block));
    assert(length > sizeof(block) * 2 && length < sizeof(out));
    assert(out[length - 1] == '\n' && out[length] == 0);
    assert(strstr(out, " 1024 b70b4c26 00010203") != NULL);
    assert(strcmp(out + length - 9, "fcfdfeff\n") == 0);
    char guarded[25];
    memset(guarded, 'X', sizeof(guarded));
    assert(!qdd_driver_format_info(guarded + 1, sizeof(guarded) - 2, 1, SESSION, 1, SHA));
    assert(guarded[0] == 'X' && guarded[sizeof(guarded) - 1] == 'X' && guarded[1] == 0);
    assert(qdd_driver_format_ok(out, sizeof(out), 8) == strlen("QDDDRV/1 8 OK\n"));
    assert(strcmp(out, "QDDDRV/1 8 OK\n") == 0);
    assert(!qdd_driver_format_ok(out, 5, 8) && !out[0]);
    assert(!qdd_driver_format_ok(out, sizeof(out), 0));
    assert(qdd_driver_format_error(out, sizeof(out), 0, "BAD_COMMAND") == strlen("QDDDRV/1 0 ERR BAD_COMMAND\n"));
    assert(strcmp(out, "QDDDRV/1 0 ERR BAD_COMMAND\n") == 0);
    const char *bad_errors[] = {"", "bad", "BAD COMMAND", "BAD\nOK", "1BAD", "BAD-COMMAND",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567"};
    for (size_t i = 0; i < sizeof(bad_errors) / sizeof(bad_errors[0]); i++)
        assert(!qdd_driver_format_error(out, sizeof(out), 1, bad_errors[i]) && !out[0]);
    assert(!qdd_driver_format_error(NULL, sizeof(out), 1, "BAD_COMMAND"));
    assert(!qdd_driver_format_error(out, 0, 1, "BAD_COMMAND"));
}

int main(void) {
    parse_commands();
    format_frames();
    puts("QDD USB driver strict requests, bounded frames and IEEE CRC32 tests: PASS");
    return 0;
}
