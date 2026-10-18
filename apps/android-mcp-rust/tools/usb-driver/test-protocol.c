#include "protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static const char *session = "0123456789abcdef";
static const char *info = "QDDDRV/1 4294967295 INFO 0123456789abcdef 943153 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP";
static const char *zero = "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8d 00";

static void invalid(const char *text) {
  qdddrv_reply reply = {0};
  const int accepted = qdddrv_parse(text, &reply);
  if (accepted) fprintf(stderr, "Unexpected accepted frame: %s\n", text);
  assert(!accepted);
}

static void parsing(void) {
  qdddrv_reply reply = {0};
  assert(qdddrv_crc32((const uint8_t *)"123456789", 9) == UINT32_C(0xcbf43926));
  assert(qdddrv_crc32((const uint8_t *)"The quick brown fox jumps over the lazy dog", 43) == UINT32_C(0x414fa339));
  assert(qdddrv_crc32((const uint8_t *)"", 0) == 0);
  assert(qdddrv_parse(info, &reply));
  assert(reply.kind == QDDDRV_INFO && reply.id == UINT32_MAX && reply.size == 943153);
  assert(strcmp(reply.session, session) == 0 && reply.sha[0] == 1 && reply.sha[31] == 239);
  assert(qdddrv_parse("QDDDRV/1 5 OK", &reply) && reply.kind == QDDDRV_OK && reply.id == 5);
  assert(qdddrv_parse("QDDDRV/1 7 ERR STALE_SESSION", &reply) && reply.kind == QDDDRV_ERR);
  assert(strcmp(reply.error, "STALE_SESSION") == 0);
  assert(qdddrv_parse("QDDDRV/1 7 ERR ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", &reply));
  assert(strlen(reply.error) == 32 && strcmp(reply.error, "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456") == 0);
  const char *bad[] = {
    "", "I (1) boot: diagnostic", "QDD/1 42 OK", "QDDDRV/2 42 OK", "QDDDRV/1 0 OK",
    "QDDDRV/1 -1 OK", "QDDDRV/1 +1 OK", "QDDDRV/1 4294967296 OK", "QDDDRV/1 1 OK extra",
    "QDDDRV/1 1  OK", " QDDDRV/1 1 OK", "QDDDRV/1 1 OK ", "QDDDRV/1 1 OK\n",
    "QDDDRV/1\t1 OK", "QDDDRV/1 1 ERR BAD COMMAND", "QDDDRV/1 1 ERR bad", "QDDDRV/1 1 ERR BAD-COMMAND",
    "QDDDRV/1 1 ERR ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567", "QDDDRV/1 1 ERR 1BAD",
    "QDDDRV/1 1 INFO 0000000000000000 1 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP",
    "QDDDRV/1 1 INFO 0123456789abcdeF 1 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP",
    "QDDDRV/1 1 INFO 0123456789abcdef 0 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP",
    "QDDDRV/1 1 INFO 0123456789abcdef 2093057 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP",
    "QDDDRV/1 1 INFO 0123456789abcdef 4294967296 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP",
    "QDDDRV/1 1 INFO 0123456789abcdef 1 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef EXE",
    "QDDDRV/1 1 INFO 0123456789abcdef 1 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ZIP extra",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 0 00000000 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1025 d202ef8d 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 4294967296 1 d202ef8d 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 4294967296 d202ef8d 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8d 0000",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8d 0",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8d 0g",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 D202EF8D 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8d 01",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 deadbeef 00",
    "QDDDRV/1 42 DATA 0123456789abcdef 0 1 d202ef8d 00 extra",
  };
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) invalid(bad[i]);
  assert(qdddrv_parse(zero, &reply));
  assert(reply.kind == QDDDRV_DATA && reply.data[0] == 0 && reply.crc == UINT32_C(0xd202ef8d));
  assert(qdddrv_matches_data(&reply, 42, session, 0, 1, 1));
  assert(!qdddrv_matches_data(&reply, 0, session, 0, 1, 1));
  assert(!qdddrv_matches_data(&reply, 41, session, 0, 1, 1));
  assert(!qdddrv_matches_data(&reply, 42, "fedcba9876543210", 0, 1, 1));
  assert(!qdddrv_matches_data(&reply, 42, session, 1, 1, 2));
  assert(!qdddrv_matches_data(&reply, 42, session, 0, 2, 2));
  assert(!qdddrv_matches_data(&reply, 42, session, 0, 1, 0));
  reply.offset = UINT32_MAX;
  assert(!qdddrv_matches_data(&reply, 42, session, UINT32_MAX, 1, UINT32_MAX));
  reply.offset = 0;
  reply.data[0] = 1;
  assert(!qdddrv_matches_data(&reply, 42, session, 0, 1, 1));

  char frame[QDDDRV_LINE_MAX];
  const int prefix = snprintf(frame, sizeof(frame), "QDDDRV/1 4294967295 DATA %s 2092032 1024 b70b4c26 ", session);
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < QDDDRV_BLOCK_MAX; ++i) {
    frame[(size_t)prefix + 2 * i] = hex[(i & 255u) >> 4];
    frame[(size_t)prefix + 2 * i + 1] = hex[i & 15u];
  }
  frame[(size_t)prefix + QDDDRV_BLOCK_MAX * 2] = 0;
  assert(qdddrv_parse(frame, &reply));
  assert(qdddrv_matches_data(&reply, UINT32_MAX, session, 2092032, 1024, QDDDRV_ZIP_MAX));
  assert(reply.data[0] == 0 && reply.data[255] == 255 && reply.data[1023] == 255);
  frame[(size_t)prefix + QDDDRV_BLOCK_MAX * 2 - 1] = '0';
  invalid(frame);
  memset(frame, 'X', sizeof(frame));
  frame[sizeof(frame) - 1] = 0;
  invalid(frame);
}

static int feed(qdddrv_line *line, const char *bytes, size_t size, qdddrv_reply *reply) {
  int valid = 0;
  for (size_t i = 0; i < size; ++i)
    if (qdddrv_line_feed(line, (unsigned char)bytes[i])) valid += qdddrv_parse(line->bytes, reply);
  return valid;
}

static void assembling(void) {
  struct { qdddrv_line line; uint32_t canary; } guarded = {0};
  guarded.canary = UINT32_C(0xdeadbeef);
  qdddrv_line *line = &guarded.line;
  qdddrv_reply reply = {0};
  assert(feed(line, "boot log\nQDDDRV/1 5 OK\r\n", strlen("boot log\nQDDDRV/1 5 OK\r\n"), &reply) == 1);
  assert(reply.id == 5 && reply.kind == QDDDRV_OK);
  const char *partial = "QDDDRV/1 41 DATA 0123456789abcdef 0 1 d202ef8d ";
  assert(!feed(line, partial, strlen(partial), &reply));
  assert(!feed(line, zero, strlen(zero), &reply));
  assert(!feed(line, "\n", 1, &reply));
  assert(feed(line, zero, strlen(zero), &reply) == 0);
  assert(feed(line, "\n", 1, &reply) == 1);
  assert(qdddrv_matches_data(&reply, 42, session, 0, 1, 1));
  assert(!qdddrv_matches_data(&reply, 41, session, 0, 1, 1));
  const char nul[] = "QDDDRV/1 1 OK\0extra\n";
  assert(!feed(line, nul, sizeof(nul) - 1, &reply));
  for (size_t i = 0; i < QDDDRV_LINE_MAX + 100u; ++i) assert(!qdddrv_line_feed(line, 'A'));
  assert(line->overflow && line->used < QDDDRV_LINE_MAX && guarded.canary == UINT32_C(0xdeadbeef));
  assert(!qdddrv_line_feed(line, '\n') && !line->overflow && !line->used);
  assert(feed(line, "QDDDRV/1 99 OK\n", strlen("QDDDRV/1 99 OK\n"), &reply) == 1 && reply.id == 99);
  assert(!feed(line, "QDDDRV/1 1 OK\r\r\n", strlen("QDDDRV/1 1 OK\r\r\n"), &reply));
}

int main(void) {
  parsing();
  assembling();
  puts("USB downloader production parser hostile frames, CRC, boundaries, stale ids and line recovery: PASS");
  return 0;
}
