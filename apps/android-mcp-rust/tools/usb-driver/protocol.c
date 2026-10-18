#include "protocol.h"

static size_t text_length(const char *text) { size_t n = 0; while (text[n]) ++n; return n; }
static int equal(const char *a, const char *b) { while (*a && *a == *b) { ++a; ++b; } return *a == *b; }
static void copy_text(char *out, const char *text) { while ((*out++ = *text++) != 0) {} }
static int decimal(const char *text, uint32_t *value) {
  uint32_t result = 0;
  if (!*text) return 0;
  do {
    if (*text < '0' || *text > '9') return 0;
    const uint32_t digit = (uint32_t)(*text++ - '0');
    if (result > (UINT32_MAX - digit) / 10u) return 0;
    result = result * 10u + digit;
  } while (*text);
  *value = result; return 1;
}
static int digit(char c) {
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
static int hex(const char *text, uint8_t *out, size_t size) {
  if (text_length(text) != size * 2u) return 0;
  for (size_t i = 0; i < size; ++i) {
    const int high = digit(text[i * 2u]), low = digit(text[i * 2u + 1u]);
    if (high < 0 || low < 0) return 0;
    out[i] = (uint8_t)((high << 4) | low);
  }
  return 1;
}
static int session(const char *text) {
  uint8_t decoded[8]; int nonzero = 0;
  if (!hex(text, decoded, sizeof(decoded))) return 0;
  for (size_t i = 0; i < sizeof(decoded); ++i) nonzero |= decoded[i];
  return nonzero != 0;
}
uint32_t qdddrv_crc32(const uint8_t *data, size_t size) {
  uint32_t crc = UINT32_MAX;
  for (size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1u) ? 0xedb88320u : 0u);
  }
  return crc ^ UINT32_MAX;
}
int qdddrv_parse(const char *line, qdddrv_reply *reply) {
  char work[QDDDRV_LINE_MAX], *parts[8]; size_t size = 0, count = 0;
  while (size < sizeof(work) && line[size]) ++size;
  if (!size || size >= sizeof(work)) return 0;
  for (size_t i = 0; i <= size; ++i) work[i] = line[i];
  parts[count++] = work;
  for (size_t i = 0; i < size; ++i) {
    if ((unsigned char)work[i] < 32 || (unsigned char)work[i] > 126) return 0;
    if (work[i] == ' ') {
      if (!i || !work[i + 1u] || work[i + 1u] == ' ' || count == 8u) return 0;
      work[i] = 0; parts[count++] = work + i + 1u;
    }
  }
  if (count < 3u || !equal(parts[0], "QDDDRV/1") || !decimal(parts[1], &reply->id) || !reply->id) return 0;
  if (equal(parts[2], "OK")) { reply->kind = QDDDRV_OK; return count == 3u; }
  if (equal(parts[2], "ERR")) {
    if (count != 4u || parts[3][0] < 'A' || parts[3][0] > 'Z' || text_length(parts[3]) >= sizeof(reply->error)) return 0;
    for (const char *p = parts[3]; *p; ++p) if (!(*p >= 'A' && *p <= 'Z') && !(*p >= '0' && *p <= '9') && *p != '_') return 0;
    copy_text(reply->error, parts[3]); reply->kind = QDDDRV_ERR; return 1;
  }
  if (count < 4u || !session(parts[3])) return 0;
  copy_text(reply->session, parts[3]);
  if (equal(parts[2], "INFO")) {
    if (count != 7u || !decimal(parts[4], &reply->size) || !reply->size || reply->size > QDDDRV_ZIP_MAX ||
        !hex(parts[5], reply->sha, sizeof(reply->sha)) || !equal(parts[6], "ZIP")) return 0;
    reply->kind = QDDDRV_INFO; return 1;
  }
  if (equal(parts[2], "DATA")) {
    uint8_t crc[4];
    if (count != 8u || !decimal(parts[4], &reply->offset) || !decimal(parts[5], &reply->length) ||
        !reply->length || reply->length > QDDDRV_BLOCK_MAX || !hex(parts[6], crc, sizeof(crc)) ||
        !hex(parts[7], reply->data, reply->length)) return 0;
    reply->crc = ((uint32_t)crc[0] << 24) | ((uint32_t)crc[1] << 16) | ((uint32_t)crc[2] << 8) | crc[3];
    if (reply->crc != qdddrv_crc32(reply->data, reply->length)) return 0;
    reply->kind = QDDDRV_DATA; return 1;
  }
  return 0;
}
int qdddrv_line_feed(qdddrv_line *line, unsigned char byte) {
  if (byte == '\n') {
    if (line->overflow) { line->used = 0; line->overflow = 0; return 0; }
    if (line->used && line->bytes[line->used - 1u] == '\r') --line->used;
    line->bytes[line->used] = 0; line->used = 0; return 1;
  }
  if (line->overflow) return 0;
  if (!byte || line->used + 1u >= sizeof(line->bytes)) { line->overflow = 1; return 0; }
  line->bytes[line->used++] = (char)byte; return 0;
}
int qdddrv_matches_data(const qdddrv_reply *reply, uint32_t id, const char *expected_session,
                       uint32_t offset, uint32_t length, uint32_t total) {
  return id && length && length <= QDDDRV_BLOCK_MAX && reply->kind == QDDDRV_DATA &&
    reply->id == id && equal(reply->session, expected_session) && reply->offset == offset &&
    reply->length == length && offset <= total && length <= total - offset &&
    reply->crc == qdddrv_crc32(reply->data, reply->length);
}
