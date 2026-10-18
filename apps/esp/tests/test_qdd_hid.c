#include "qdd_hid.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned reports;
static unsigned failures;
static uint8_t last_id;
static uint8_t last_data[8];
static size_t last_length;

static bool report(uint8_t id, const uint8_t *data, size_t length, void *context) {
  (void)context;
  reports++;
  last_id = id;
  last_length = length;
  memcpy(last_data, data, length);
  if (failures) { failures--; return false; }
  return true;
}

static const char *execute(qdd_hid_state_t *state, const char *line, uint64_t now) {
  qdd_command_t command;
  assert(qdd_parse_command(line, &command));
  return qdd_hid_execute(state, &command, now, report, NULL);
}

static void parser_tests(void) {
  const char *valid[] = {
    "QDDHID/1 1 PING", "QDDHID/1 2147483647 STATUS", "QDDHID/1 2 ARM",
    "QDDHID/1 3 PAUSE", "QDDHID/1 4 RELEASE", "QDDHID/1 5 MOVE -127 127 0 7",
    "QDDHID/1 6 KEY 255 255", "QDDHID/1 7 CONSUMER 65535", "QDDHID/1 8 KEY 0 0",
    "QDDHID/1 9 PAIR", "QDDHID/1 10 PAIR_STATUS"
  };
  const char *invalid[] = {
    "", "PING", "QDDHID/2 1 PING", "QDDHID/1 0 PING", "QDDHID/1 -1 PING",
    "QDDHID/1 2147483648 PING", "QDDHID/1 999999999999999999999999 PING",
    "QDDHID/1 +1 PING", "QDDHID/1 1 ping", "QDDHID/1 1 PING extra",
    "QDDHID/1 1 MOVE 1 2 3", "QDDHID/1 1 MOVE 1 2 3 4 5",
    "QDDHID/1 1 MOVE -128 0 0 0", "QDDHID/1 1 MOVE 0 128 0 0",
    "QDDHID/1 1 MOVE 0 0 128 0", "QDDHID/1 1 MOVE 0 0 0 8",
    "QDDHID/1 1 MOVE 0 0 0 -1", "QDDHID/1 1 KEY 256 0", "QDDHID/1 1 KEY 0 256",
    "QDDHID/1 1 KEY -1 1", "QDDHID/1 1 CONSUMER 65536",
    "QDDHID/1 1 CONSUMER -1", "QDDHID/1 1 KEY 1.0 2", "QDDHID/1 1 KEY 0x01 2",
    "QDDHID/1\t1 PING", "QDDHID/1 1 PING\rjunk", "QDDHID/1 1 UNKNOWN",
    "QDDHID/1 1 PAIR extra", "QDDHID/1 1 PAIR_STATUS extra"
  };
  qdd_command_t command;
  for (size_t i = 0; i < sizeof(valid) / sizeof(valid[0]); i++) assert(qdd_parse_command(valid[i], &command));
  for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) assert(!qdd_parse_command(invalid[i], &command));
  assert(!qdd_parse_command("QDDHID/1 42 MOVE 999 0 0 0", &command));
  assert(command.id == 42); // malformed args still correlate the error.
}

static unsigned lines;
static unsigned bad_lines;
static unsigned long_lines;
static void line(const char *text, const char *error, void *context) {
  (void)context;
  lines++;
  if (error) {
    if (strcmp(error, "LINE_TOO_LONG") == 0) long_lines++;
    else bad_lines++;
  } else {
    qdd_command_t command;
    assert(qdd_parse_command(text, &command));
  }
}

static void stream_tests(void) {
  const char *input = "QDDHID/1 1 PING\r\nQDDHID/1 2 MOVE -127 127 0 7\n";
  for (size_t split = 0; split <= strlen(input); split++) {
    qdd_stream_t stream = {0};
    lines = bad_lines = long_lines = 0;
    qdd_stream_feed(&stream, (const uint8_t *)input, split, line, NULL);
    qdd_stream_feed(&stream, (const uint8_t *)input + split, strlen(input) - split, line, NULL);
    assert(lines == 2 && !bad_lines && !long_lines && !stream.length);
  }
  qdd_stream_t stream = {0};
  char overflow[QDD_LINE_MAX + 32];
  memset(overflow, 'A', sizeof(overflow));
  lines = bad_lines = long_lines = 0;
  qdd_stream_feed(&stream, (const uint8_t *)overflow, sizeof(overflow), line, NULL);
  const char *suffix = "QDDHID/1 1 ARM\nQDDHID/1 2 PING\n";
  qdd_stream_feed(&stream, (const uint8_t *)suffix, strlen(suffix), line, NULL);
  assert(lines == 2 && long_lines == 1); // suffix of overflow never executes.
  const uint8_t nul_line[] = {'Q', 0, '\n'};
  qdd_stream_feed(&stream, nul_line, sizeof(nul_line), line, NULL);
  assert(bad_lines == 1);
}

static void safety_tests(void) {
  qdd_hid_state_t state = {0};
  assert(strcmp(execute(&state, "QDDHID/1 1 ARM", 100), "NOT_CONNECTED") == 0);
  qdd_hid_set_link(&state, true, false, false, false);
  assert(strcmp(execute(&state, "QDDHID/1 2 ARM", 100), "NOT_AUTHENTICATED") == 0);
  qdd_hid_set_link(&state, true, true, true, true);
  assert(strcmp(execute(&state, "QDDHID/1 3 ARM", 100), "HID_NOT_READY") == 0);
  qdd_hid_set_ready(&state, true, false);
  assert(strcmp(execute(&state, "QDDHID/1 3 ARM", 100), "HEARTBEAT_EXPIRED") == 0);
  assert(execute(&state, "QDDHID/1 4 PING", 100) == NULL);
  assert(execute(&state, "QDDHID/1 5 ARM", 100) == NULL && state.armed);
  assert(execute(&state, "QDDHID/1 6 MOVE -127 127 1 7", 100) == NULL);
  assert(last_id == QDD_REPORT_MOUSE && last_length == 4);
  assert(last_data[0] == 7 && last_data[1] == 129 && last_data[2] == 127 && last_data[3] == 1);
  assert(execute(&state, "QDDHID/1 7 KEY 2 4", 100) == NULL);
  assert(last_id == QDD_REPORT_KEYBOARD && last_data[0] == 2 && last_data[2] == 4);
  assert(execute(&state, "QDDHID/1 8 KEY 255 0", 100) == NULL);
  for (size_t i = 0; i < 8; i++) assert(last_data[i] == 0);
  assert(strcmp(execute(&state, "QDDHID/1 9 CONSUMER 548", 100), "HID_NOT_READY") == 0);
  assert(execute(&state, "QDDHID/1 9 CONSUMER 0", 100) == NULL);
  qdd_hid_set_ready(&state, true, true);
  assert(execute(&state, "QDDHID/1 9 CONSUMER 548", 100) == NULL);
  assert(last_id == QDD_REPORT_CONSUMER && last_data[0] == 0x24 && last_data[1] == 2);
  qdd_hid_tick(&state, 1600, true);
  assert(state.armed); // inclusive 1500 ms deadline.
  qdd_hid_tick(&state, 1601, true);
  assert(!state.armed && state.release_required);
  assert(execute(&state, "QDDHID/1 10 STATUS", 1601) == NULL);
  assert(state.last_ping_ms == 100); // only PING renews the lease.
  qdd_hid_pause(&state, true);
  assert(execute(&state, "QDDHID/1 11 PING", 1700) == NULL);
  assert(strcmp(execute(&state, "QDDHID/1 12 ARM", 1700), "LOCKED") == 0);
  assert(execute(&state, "QDDHID/1 13 PAUSE", 1700) == NULL && state.locked);
  assert(execute(&state, "QDDHID/1 14 RELEASE", 1700) == NULL && state.locked);
  qdd_hid_unlock(&state);
  assert(!state.locked && !state.armed);
  assert(execute(&state, "QDDHID/1 15 ARM", 1700) == NULL);
  qdd_hid_set_link(&state, false, false, false, false);
  assert(!state.armed);
  qdd_hid_set_link(&state, true, true, true, true);
  assert(!state.armed && !state.ready);
  assert(strcmp(execute(&state, "QDDHID/1 16 ARM", 1700), "HID_NOT_READY") == 0);
  qdd_hid_set_ready(&state, true, true);
  assert(execute(&state, "QDDHID/1 16 KEY 0 4", 1700) == NULL && state.armed);
  assert(execute(&state, "QDDHID/1 17 ARM", 1700) == NULL);
  qdd_hid_tick(&state, 1700, false);
  assert(!state.armed && !state.heartbeat_seen);
  assert(strcmp(execute(&state, "QDDHID/1 18 ARM", 1700), "HEARTBEAT_EXPIRED") == 0);
  assert(execute(&state, "QDDHID/1 19 PING", 1800) == NULL);
  assert(execute(&state, "QDDHID/1 20 ARM", 1800) == NULL);
  qdd_hid_set_ready(&state, false, false);
  assert(!state.armed && state.release_required);
  assert(strcmp(execute(&state, "QDDHID/1 20 MOVE 1 0 0 0", 1800), "HID_NOT_READY") == 0);
  qdd_hid_set_ready(&state, true, true);
  assert(!state.armed);
  assert(execute(&state, "QDDHID/1 20 ARM", 1800) == NULL);
  failures = 1;
  const unsigned before = reports;
  assert(strcmp(execute(&state, "QDDHID/1 21 KEY 0 4", 1800), "HID_SEND_FAILED") == 0);
  assert(!state.armed && reports == before + 4); // failed send + all 3 releases.
  failures = 1;
  assert(!qdd_hid_release(&state, report, NULL) && state.release_required);
  assert(qdd_hid_release(&state, report, NULL) && !state.release_required);
  char reply[QDD_REPLY_MAX];
  qdd_format_reply(reply, sizeof(reply), 42, NULL, &state, "QDD-Passport-1234");
  assert(strstr(reply, "QDDHID/1 42 OK {\"v\":1,") == reply);
  assert(strstr(reply, "\"armed\":false") && strstr(reply, "\"name\":\"QDD-Passport-1234\"}"));
  assert(strstr(reply, "\"ready\":true"));
  qdd_format_reply(reply, sizeof(reply), 42, "LOCKED", &state, "QDD-Passport-1234");
  assert(strcmp(reply, "QDDHID/1 42 ERR LOCKED\n") == 0);
}

static void subscription_tests(void) {
  qdd_hid_subscriptions_t subscriptions;
  qdd_hid_subscriptions_reset(&subscriptions);
  assert(subscriptions.protocol_mode == 1);
  assert(!qdd_hid_subscriptions_ready(&subscriptions));
  qdd_hid_subscriptions_set(&subscriptions, 1, QDD_REPORT_MOUSE, true);
  assert(!qdd_hid_subscriptions_ready(&subscriptions));
  qdd_hid_subscriptions_set(&subscriptions, 1, QDD_REPORT_KEYBOARD, true);
  assert(qdd_hid_subscriptions_ready(&subscriptions));
  assert(!qdd_hid_subscriptions_notifying(&subscriptions, QDD_REPORT_CONSUMER));
  qdd_hid_subscriptions_set(&subscriptions, 1, QDD_REPORT_CONSUMER, true);
  assert(qdd_hid_subscriptions_notifying(&subscriptions, QDD_REPORT_CONSUMER));
  qdd_hid_subscriptions_set(&subscriptions, 1, QDD_REPORT_KEYBOARD, false);
  assert(!qdd_hid_subscriptions_ready(&subscriptions));
  qdd_hid_subscriptions_set(&subscriptions, 1, QDD_REPORT_KEYBOARD, true);
  subscriptions.protocol_mode = 0;
  assert(!qdd_hid_subscriptions_ready(&subscriptions));
  qdd_hid_subscriptions_set(&subscriptions, 0, QDD_REPORT_MOUSE, true);
  qdd_hid_subscriptions_set(&subscriptions, 0, QDD_REPORT_KEYBOARD, true);
  assert(qdd_hid_subscriptions_ready(&subscriptions));
  assert(!qdd_hid_subscriptions_notifying(&subscriptions, QDD_REPORT_CONSUMER));
  subscriptions.protocol_mode = 255;
  assert(!qdd_hid_subscriptions_ready(&subscriptions));
  qdd_hid_subscriptions_set(&subscriptions, 2, QDD_REPORT_MOUSE, true);
  qdd_hid_subscriptions_set(&subscriptions, 1, 8, true);
  qdd_hid_subscriptions_reset(&subscriptions);
  assert(!qdd_hid_subscriptions_ready(&subscriptions)); // reconnect resets CCCDs.
}

static void automatic_control_tests(void) {
  qdd_hid_state_t state = {0};
  qdd_hid_set_link(&state, true, true, true, true);
  qdd_hid_set_ready(&state, true, true);
  assert(execute(&state, "QDDHID/1 1 PING", 100) == NULL);
  assert(!state.armed); // Heartbeats never generate input or an enable/release loop.
  unsigned before = reports;
  assert(execute(&state, "QDDHID/1 2 MOVE 3 -4 0 0", 100) == NULL);
  assert(state.armed && !state.release_required && reports == before + 4);
  assert(last_id == QDD_REPORT_MOUSE && last_data[1] == 3 && last_data[2] == 252);
  assert(execute(&state, "QDDHID/1 3 PAUSE", 100) == NULL && !state.armed);
  before = reports;
  assert(execute(&state, "QDDHID/1 4 KEY 0 4", 100) == NULL);
  assert(state.armed && reports == before + 4); // No separate user ARM is required.
  assert(execute(&state, "QDDHID/1 5 PAUSE", 100) == NULL);
  failures = 1;
  before = reports;
  assert(strcmp(execute(&state, "QDDHID/1 6 MOVE 10 0 0 1", 100), "HID_SEND_FAILED") == 0);
  assert(!state.armed && state.release_required && reports == before + 3);
  for (size_t i = 0; i < last_length; i++) assert(last_data[i] == 0);
  assert(execute(&state, "QDDHID/1 7 MOVE 10 0 0 1", 100) == NULL && state.armed);
  qdd_hid_pause(&state, true);
  before = reports;
  assert(strcmp(execute(&state, "QDDHID/1 8 MOVE 1 0 0 0", 100), "LOCKED") == 0);
  assert(reports == before && state.locked);
  qdd_hid_unlock(&state);
  assert(!state.armed && !state.locked);
  assert(execute(&state, "QDDHID/1 9 CONSUMER 548", 100) == NULL && state.armed);
  qdd_hid_tick(&state, 1601, true);
  before = reports;
  assert(strcmp(execute(&state, "QDDHID/1 10 MOVE 1 0 0 0", 1601), "HEARTBEAT_EXPIRED") == 0);
  assert(!state.armed && reports == before);
  assert(execute(&state, "QDDHID/1 11 PING", 1601) == NULL);
  assert(execute(&state, "QDDHID/1 12 MOVE 1 0 0 0", 1601) == NULL && state.armed);
  qdd_hid_set_link(&state, false, false, false, false);
  assert(strcmp(execute(&state, "QDDHID/1 13 KEY 0 4", 1601), "NOT_CONNECTED") == 0);
  qdd_hid_set_link(&state, true, true, true, true);
  assert(strcmp(execute(&state, "QDDHID/1 14 KEY 0 4", 1601), "HID_NOT_READY") == 0);
  qdd_hid_set_ready(&state, true, true);
  assert(execute(&state, "QDDHID/1 15 KEY 0 4", 1601) == NULL && state.armed);
}

static void pnp_tests(void) {
  uint8_t value[7];
  const uint8_t development[] = {1, 0xFF, 0xFF, 0, 0, 0, 1};
  assert(qdd_hid_pnp_id(value, 1, 0xFFFF, 0, 0x0100));
  assert(memcmp(value, development, sizeof(value)) == 0);
  const uint8_t encoded[] = {2, 0x34, 0x12, 0x78, 0x56, 0xBC, 0x9A};
  assert(qdd_hid_pnp_id(value, 2, 0x1234, 0x5678, 0x9ABC));
  assert(memcmp(value, encoded, sizeof(value)) == 0);
  assert(!qdd_hid_pnp_id(value, 0, 0, 0, 0));
  assert(!qdd_hid_pnp_id(value, 3, 0, 0, 0));
  assert(memcmp(value, encoded, sizeof(value)) == 0);
}

static void pairing_management_tests(void) {
  qdd_hid_state_t state = {0};
  qdd_hid_set_link(&state, true, true, true, true);
  qdd_hid_set_ready(&state, true, true);
  assert(execute(&state, "QDDHID/1 1 PING", 100) == NULL);
  assert(execute(&state, "QDDHID/1 2 ARM", 100) == NULL);
  const unsigned before = reports;
  assert(execute(&state, "QDDHID/1 3 PAIR", 100) == NULL);
  assert(!state.armed && reports == before + 3);
  qdd_hid_pause(&state, true);
  assert(execute(&state, "QDDHID/1 4 PAIR", 100) == NULL && state.locked);
  const unsigned after = reports;
  assert(execute(&state, "QDDHID/1 5 PAIR_STATUS", 200) == NULL);
  assert(reports == after && state.locked && state.last_ping_ms == 100);
  char reply[QDD_REPLY_MAX];
  qdd_format_reply(reply, sizeof(reply), 1, NULL, &state, "QDD-Passport-1234");
  assert(!strstr(reply, "passkey") && !strstr(reply, "pairingOpen"));
  qdd_format_pairing_reply(reply, sizeof(reply), 1, NULL, &state,
                           "QDD-Passport-1234", true, true, 123456);
  assert(strstr(reply, "\"pairingOpen\":true,\"passkeyVisible\":true,\"passkey\":123456}"));
  assert(strstr(reply, "\"locked\":true"));
  qdd_format_pairing_reply(reply, sizeof(reply), 1, NULL, &state,
                           "QDD-Passport-1234", false, true, 123456);
  assert(strstr(reply, "\"pairingOpen\":false,\"passkeyVisible\":false}"));
  assert(!strstr(reply, "\"passkey\":"));
  qdd_format_pairing_reply(reply, sizeof(reply), 1, NULL, &state,
                           "QDD-Passport-1234", true, false, 123456);
  assert(!strstr(reply, "\"passkey\":"));
  qdd_format_pairing_reply(reply, sizeof(reply), 1, "BAD_COMMAND", &state,
                           "QDD-Passport-1234", true, true, 123456);
  assert(strcmp(reply, "QDDHID/1 1 ERR BAD_COMMAND\n") == 0);
}

static void just_works_security_tests(void) {
  qdd_hid_state_t state = {0};
  qdd_hid_set_link(&state, true, true, false, true);
  qdd_hid_set_ready(&state, true, true);
  assert(!state.authenticated); // Just Works has no MITM flag; never synthesize it.
  assert(execute(&state, "QDDHID/1 1 PING", 100) == NULL);
  assert(execute(&state, "QDDHID/1 2 ARM", 100) == NULL && state.armed);
  assert(qdd_hid_text_permission(&state, 100) == NULL);
  const unsigned before = reports;
  assert(execute(&state, "QDDHID/1 3 KEY 0 4", 100) == NULL);
  assert(qdd_hid_release(&state, report, NULL) && reports == before + 4);
  qdd_hid_set_link(&state, true, false, false, true);
  assert(!state.armed && !state.ready);
  assert(strcmp(execute(&state, "QDDHID/1 4 ARM", 100), "NOT_AUTHENTICATED") == 0);
  qdd_hid_set_link(&state, true, true, false, false);
  qdd_hid_set_ready(&state, true, true);
  assert(strcmp(execute(&state, "QDDHID/1 5 ARM", 100), "NOT_AUTHENTICATED") == 0);
  const unsigned unbonded_reports = reports;
  assert(qdd_hid_release(&state, report, NULL) && reports == unbonded_reports);
  qdd_hid_set_link(&state, true, true, true, true); // Existing MITM bond still works.
  qdd_hid_set_ready(&state, true, true);
  assert(execute(&state, "QDDHID/1 6 ARM", 100) == NULL && state.armed);
}

int main(void) {
  parser_tests();
  stream_tests();
  safety_tests();
  subscription_tests();
  automatic_control_tests();
  pnp_tests();
  pairing_management_tests();
  just_works_security_tests();
  puts("QDD HID protocol and safety tests: PASS");
  return 0;
}
