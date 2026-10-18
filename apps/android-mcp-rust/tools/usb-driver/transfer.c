#include "transfer.h"

static uint32_t next(uint32_t *id) { if (!++*id) ++*id; return *id; }
static int equal(const char *a, const char *b) { while (*a && *a == *b) { ++a; ++b; } return *a == *b; }
static int retryable(const qdddrv_reply *reply) {
  return reply->kind == QDDDRV_ERR && (equal(reply->error, "BUSY") || equal(reply->error, "IO_ERROR"));
}
qdddrv_result qdddrv_transfer(const qdddrv_io *io, qdddrv_reply *info) {
  qdddrv_reply reply; uint32_t id = io->first_id, offset = 0; int found = 0, recovered = 0;
  info->session[0] = 0;
  for (unsigned attempt = 0; attempt < 3; ++attempt) {
    if (io->cancelled(io->context)) return QDDDRV_TRANSFER_CANCELLED;
    const uint32_t request = next(&id);
    const int result = io->exchange(io->context, QDDDRV_REQUEST_INFO, request, "", 0, 0, &reply);
    if (result < 0) return io->cancelled(io->context) ? QDDDRV_TRANSFER_CANCELLED : QDDDRV_TRANSFER_IO;
    if (!result || reply.id != request) continue;
    if (reply.kind == QDDDRV_ERR && !retryable(&reply)) return QDDDRV_TRANSFER_PROTOCOL;
    if (reply.kind != QDDDRV_INFO || !reply.size || reply.size > QDDDRV_ZIP_MAX) continue;
    *info = reply; found = 1; break;
  }
  if (!found) return QDDDRV_TRANSFER_PROTOCOL;
  while (offset < info->size) {
    const uint32_t length = info->size - offset < QDDDRV_BLOCK_MAX ? info->size - offset : QDDDRV_BLOCK_MAX;
    int accepted = 0;
    for (unsigned attempt = 0; attempt < 3; ++attempt) {
      if (io->cancelled(io->context)) return QDDDRV_TRANSFER_CANCELLED;
      const uint32_t request = next(&id);
      const int result = io->exchange(io->context, QDDDRV_REQUEST_READ, request, info->session, offset, length, &reply);
      if (result < 0) return io->cancelled(io->context) ? QDDDRV_TRANSFER_CANCELLED : QDDDRV_TRANSFER_IO;
      if (!result || reply.id != request) continue;
      if (reply.kind == QDDDRV_ERR && !recovered &&
          (equal(reply.error, "STALE_SESSION") || equal(reply.error, "IO_ERROR"))) {
        if (io->cancelled(io->context)) return QDDDRV_TRANSFER_CANCELLED;
        recovered = 1;
        const uint32_t refresh = next(&id);
        const int renewed = io->exchange(io->context, QDDDRV_REQUEST_INFO, refresh, "", 0, 0, &reply);
        if (renewed != 1 || reply.id != refresh || reply.kind != QDDDRV_INFO)
          return io->cancelled(io->context) ? QDDDRV_TRANSFER_CANCELLED : QDDDRV_TRANSFER_PROTOCOL;
        /* Retain the original size/SHA; a new session may only resume the exact ZIP. */
        unsigned different = reply.size != info->size;
        for (unsigned i = 0; i < 32; ++i) different |= reply.sha[i] ^ info->sha[i];
        for (unsigned i = 0; i < 17; ++i) info->session[i] = reply.session[i];
        if (io->cancelled(io->context)) return QDDDRV_TRANSFER_CANCELLED;
        if (different) return QDDDRV_TRANSFER_PROTOCOL;
        continue;
      }
      if (reply.kind == QDDDRV_ERR && !retryable(&reply)) return QDDDRV_TRANSFER_PROTOCOL;
      if (qdddrv_matches_data(&reply, request, info->session, offset, length, info->size)) { accepted = 1; break; }
    }
    if (!accepted) return QDDDRV_TRANSFER_PROTOCOL;
    if (io->cancelled(io->context)) return QDDDRV_TRANSFER_CANCELLED;
    if (!io->append(io->context, reply.data, length)) return QDDDRV_TRANSFER_IO;
    offset += length;
    io->progress(io->context, offset, info->size);
  }
  if (io->cancelled(io->context)) return QDDDRV_TRANSFER_CANCELLED;
  return io->verify_sha(io->context, info->sha) ? QDDDRV_TRANSFER_OK : QDDDRV_TRANSFER_SHA;
}
