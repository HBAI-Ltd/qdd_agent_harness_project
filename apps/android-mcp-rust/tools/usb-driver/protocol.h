#ifndef QDD_USB_DRIVER_PROTOCOL_H
#define QDD_USB_DRIVER_PROTOCOL_H
#include <stddef.h>
#include <stdint.h>

#define QDDDRV_BLOCK_MAX 1024u
#define QDDDRV_LINE_MAX 2304u
#define QDDDRV_ZIP_MAX (2u * 1024u * 1024u - 4096u)
typedef enum { QDDDRV_INFO = 1, QDDDRV_DATA, QDDDRV_OK, QDDDRV_ERR } qdddrv_kind;
typedef struct {
  uint32_t id, size, offset, length, crc;
  qdddrv_kind kind;
  char session[17], error[33];
  uint8_t sha[32], data[QDDDRV_BLOCK_MAX];
} qdddrv_reply;
typedef struct { char bytes[QDDDRV_LINE_MAX]; size_t used; int overflow; } qdddrv_line;

uint32_t qdddrv_crc32(const uint8_t *data, size_t size);
int qdddrv_parse(const char *line, qdddrv_reply *reply);
/* Returns 1 only for a complete bounded line. Overflow/NUL discard through LF. */
int qdddrv_line_feed(qdddrv_line *line, unsigned char byte);
int qdddrv_matches_data(const qdddrv_reply *reply, uint32_t id, const char *session,
                       uint32_t offset, uint32_t length, uint32_t total);
#endif
