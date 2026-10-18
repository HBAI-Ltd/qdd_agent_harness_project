#include "transfer.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef enum {
  NORMAL, TIMEOUT_OLD_ID, CRC_BAD, OFFSET_BAD, SESSION_BAD, LENGTH_BAD,
  BUSY_INFO, BUSY_READ, BUSY_FOREVER, STALE_INFO, STALE_READ,
  CANCEL_BEFORE, CANCEL_AFTER_APPEND, CANCEL_AFTER_EXCHANGE, APPEND_FAIL,
  SHA_FAIL, IO_FAIL, INFO_SIZE_BAD, RECOVER_STALE, RECOVER_IO,
  RECOVER_SHA_CHANGED, RECOVER_SIZE_CHANGED, CANCEL_ON_STALE
} scenario_t;

typedef struct {
  scenario_t scenario;
  uint8_t expected[2501], received[2501], sha[32];
  uint32_t ids[20], offsets[20], lengths[20], received_size;
  unsigned requests, infos, reads, appends, progress, verified;
  int cancelled;
} fixture_t;

static int exchange(void *context, qdddrv_command command, uint32_t id,
    const char *session, uint32_t offset, uint32_t length, qdddrv_reply *reply) {
  fixture_t *state = context;
  assert(state->requests < 20 && id);
  state->ids[state->requests] = id;
  state->offsets[state->requests] = offset;
  state->lengths[state->requests++] = length;
  memset(reply, 0, sizeof(*reply));
  reply->id = id;
  if (command == QDDDRV_REQUEST_INFO) {
    assert(!session[0] && offset == 0 && length == 0);
    state->infos++;
    if (state->scenario == STALE_INFO) {
      reply->kind = QDDDRV_ERR;
      strcpy(reply->error, "STALE_SESSION");
      return 1;
    }
    if (state->scenario == BUSY_FOREVER || (state->scenario == BUSY_INFO && state->infos <= 2)) {
      reply->kind = QDDDRV_ERR;
      strcpy(reply->error, "BUSY");
      return 1;
    }
    reply->kind = QDDDRV_INFO;
    reply->size = state->scenario == INFO_SIZE_BAD ? QDDDRV_ZIP_MAX + 1u : sizeof(state->expected);
    const int recovery = state->scenario >= RECOVER_STALE && state->infos > 1;
    strcpy(reply->session, recovery ? "fedcba9876543210" : "0123456789abcdef");
    memcpy(reply->sha, state->sha, sizeof(reply->sha));
    if (recovery && state->scenario == RECOVER_SHA_CHANGED) reply->sha[7] ^= 1u;
    if (recovery && state->scenario == RECOVER_SIZE_CHANGED) reply->size++;
    return 1;
  }
  assert(command == QDDDRV_REQUEST_READ);
  assert(strcmp(session, state->scenario >= RECOVER_STALE && state->infos > 1 ?
    "fedcba9876543210" : "0123456789abcdef") == 0);
  assert(length && length <= QDDDRV_BLOCK_MAX && offset <= sizeof(state->expected));
  assert(length <= sizeof(state->expected) - offset);
  state->reads++;
  if (state->scenario == IO_FAIL) return -1;
  if (state->scenario == TIMEOUT_OLD_ID && state->reads == 1) return 0;
  if (state->scenario == STALE_READ) {
    reply->kind = QDDDRV_ERR;
    strcpy(reply->error, "STALE_SESSION");
    return 1;
  }
  if (state->scenario >= RECOVER_STALE && state->reads == 2) {
    reply->kind = QDDDRV_ERR;
    strcpy(reply->error, state->scenario == RECOVER_IO ? "IO_ERROR" : "STALE_SESSION");
    if (state->scenario == CANCEL_ON_STALE) state->cancelled = 1;
    return 1;
  }
  if (state->scenario == BUSY_READ && state->reads <= 2) {
    reply->kind = QDDDRV_ERR;
    strcpy(reply->error, "BUSY");
    return 1;
  }
  reply->kind = QDDDRV_DATA;
  strcpy(reply->session, session);
  reply->offset = offset;
  reply->length = length;
  memcpy(reply->data, state->expected + offset, length);
  reply->crc = qdddrv_crc32(reply->data, length);
  if (state->scenario == TIMEOUT_OLD_ID && state->reads == 2) reply->id = id - 1;
  if (state->scenario == CRC_BAD) reply->crc ^= 1u;
  if (state->scenario == OFFSET_BAD) reply->offset++;
  if (state->scenario == SESSION_BAD) strcpy(reply->session, "fedcba9876543210");
  if (state->scenario == LENGTH_BAD) reply->length--;
  if (state->scenario == CANCEL_AFTER_EXCHANGE) state->cancelled = 1;
  return 1;
}

static int append(void *context, const uint8_t *bytes, uint32_t size) {
  fixture_t *state = context;
  state->appends++;
  if (state->scenario == APPEND_FAIL) return 0;
  assert(size <= sizeof(state->received) - state->received_size);
  memcpy(state->received + state->received_size, bytes, size);
  state->received_size += size;
  if (state->scenario == CANCEL_AFTER_APPEND) state->cancelled = 1;
  return 1;
}

static int verify(void *context, const uint8_t *sha) {
  fixture_t *state = context;
  state->verified++;
  assert(state->received_size == sizeof(state->expected));
  assert(memcmp(state->received, state->expected, sizeof(state->expected)) == 0);
  assert(memcmp(sha, state->sha, sizeof(state->sha)) == 0);
  return state->scenario != SHA_FAIL;
}

static int cancelled(void *context) { return ((fixture_t *)context)->cancelled; }
static void progress(void *context, uint32_t received, uint32_t total) {
  fixture_t *state = context;
  assert(total == sizeof(state->expected) && received == state->received_size);
  state->progress++;
}

static qdddrv_result run(fixture_t *state, scenario_t scenario, uint32_t first_id) {
  memset(state, 0, sizeof(*state));
  state->scenario = scenario;
  state->cancelled = scenario == CANCEL_BEFORE;
  for (size_t i = 0; i < sizeof(state->expected); ++i) state->expected[i] = (uint8_t)(i * 17u + 3u);
  for (size_t i = 0; i < sizeof(state->sha); ++i) state->sha[i] = (uint8_t)(i * 7u);
  const qdddrv_io io = {
    .context = state, .first_id = first_id, .exchange = exchange, .append = append,
    .verify_sha = verify, .cancelled = cancelled, .progress = progress
  };
  qdddrv_reply info = {0};
  const qdddrv_result result = qdddrv_transfer(&io, &info);
  if (state->reads && result == QDDDRV_TRANSFER_OK) assert(strcmp(info.session,
    scenario >= RECOVER_STALE && state->infos > 1 ? "fedcba9876543210" : "0123456789abcdef") == 0);
  return result;
}

int main(void) {
  fixture_t state;
  assert(run(&state, NORMAL, 0) == QDDDRV_TRANSFER_OK);
  assert(state.infos == 1 && state.reads == 3 && state.appends == 3 && state.progress == 3 && state.verified == 1);
  assert(state.offsets[1] == 0 && state.offsets[2] == 1024 && state.offsets[3] == 2048);
  assert(state.lengths[1] == 1024 && state.lengths[2] == 1024 && state.lengths[3] == 453);

  assert(run(&state, TIMEOUT_OLD_ID, 10) == QDDDRV_TRANSFER_OK);
  assert(state.infos == 1 && state.reads == 5 && state.appends == 3 && state.verified == 1);
  assert(state.offsets[1] == 0 && state.offsets[2] == 0 && state.offsets[3] == 0 && state.offsets[4] == 1024);
  assert(state.ids[1] == 12 && state.ids[2] == 13 && state.ids[3] == 14);
  const scenario_t mismatch[] = {CRC_BAD, OFFSET_BAD, SESSION_BAD, LENGTH_BAD};
  for (size_t i = 0; i < sizeof(mismatch) / sizeof(mismatch[0]); ++i) {
    assert(run(&state, mismatch[i], 0) == QDDDRV_TRANSFER_PROTOCOL);
    assert(state.infos == 1 && state.reads == 3 && !state.appends && !state.verified);
    assert(state.offsets[1] == 0 && state.offsets[2] == 0 && state.offsets[3] == 0);
  }
  assert(run(&state, BUSY_INFO, 0) == QDDDRV_TRANSFER_OK && state.infos == 3 && state.appends == 3);
  assert(run(&state, BUSY_READ, 0) == QDDDRV_TRANSFER_OK && state.infos == 1 && state.reads == 5 && state.appends == 3);
  assert(run(&state, BUSY_FOREVER, 0) == QDDDRV_TRANSFER_PROTOCOL && state.infos == 3 && !state.reads && !state.appends);
  assert(run(&state, STALE_INFO, 0) == QDDDRV_TRANSFER_PROTOCOL && state.infos == 1 && !state.reads);
  assert(run(&state, STALE_READ, 0) == QDDDRV_TRANSFER_PROTOCOL && state.infos == 2 && state.reads == 2 && !state.appends);
  assert(run(&state, INFO_SIZE_BAD, 0) == QDDDRV_TRANSFER_PROTOCOL && state.infos == 3 && !state.reads);
  assert(run(&state, CANCEL_BEFORE, 0) == QDDDRV_TRANSFER_CANCELLED && !state.requests && !state.appends);
  assert(run(&state, CANCEL_AFTER_APPEND, 0) == QDDDRV_TRANSFER_CANCELLED);
  assert(state.infos == 1 && state.reads == 1 && state.appends == 1 && state.received_size == 1024 && !state.verified);
  assert(run(&state, CANCEL_AFTER_EXCHANGE, 0) == QDDDRV_TRANSFER_CANCELLED);
  assert(state.infos == 1 && state.reads == 1 && !state.appends && !state.verified);
  assert(run(&state, APPEND_FAIL, 0) == QDDDRV_TRANSFER_IO && state.reads == 1 && state.appends == 1 && !state.verified);
  assert(run(&state, IO_FAIL, 0) == QDDDRV_TRANSFER_IO && state.reads == 1 && !state.appends);
  assert(run(&state, SHA_FAIL, 0) == QDDDRV_TRANSFER_SHA && state.appends == 3 && state.verified == 1);
  assert(run(&state, NORMAL, UINT32_MAX - 1u) == QDDDRV_TRANSFER_OK);
  assert(state.ids[0] == UINT32_MAX && state.ids[1] == 1 && state.ids[2] == 2 && state.ids[3] == 3);
  assert(run(&state, RECOVER_STALE, 0) == QDDDRV_TRANSFER_OK);
  assert(state.infos == 2 && state.reads == 4 && state.appends == 3 && state.verified == 1);
  assert(state.offsets[1] == 0 && state.offsets[2] == 1024 && state.offsets[3] == 0 && state.offsets[4] == 1024);
  assert(run(&state, RECOVER_IO, 0) == QDDDRV_TRANSFER_OK);
  assert(state.infos == 2 && state.reads == 4 && state.appends == 3 && state.verified == 1);
  assert(state.offsets[2] == 1024 && state.offsets[4] == 1024);
  assert(run(&state, RECOVER_SHA_CHANGED, 0) == QDDDRV_TRANSFER_PROTOCOL);
  assert(state.infos == 2 && state.reads == 2 && state.appends == 1 && state.received_size == 1024 && !state.verified);
  assert(run(&state, RECOVER_SIZE_CHANGED, 0) == QDDDRV_TRANSFER_PROTOCOL);
  assert(state.infos == 2 && state.reads == 2 && state.appends == 1 && state.received_size == 1024 && !state.verified);
  assert(run(&state, CANCEL_ON_STALE, 0) == QDDDRV_TRANSFER_CANCELLED);
  assert(state.infos == 1 && state.reads == 2 && state.appends == 1 && !state.verified);
  puts("USB downloader production transfer engine: 24 failure/success/recovery scenarios PASS");
  return 0;
}
