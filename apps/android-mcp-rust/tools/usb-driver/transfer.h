#ifndef QDD_USB_DRIVER_TRANSFER_H
#define QDD_USB_DRIVER_TRANSFER_H
#include "protocol.h"
typedef enum { QDDDRV_REQUEST_INFO, QDDDRV_REQUEST_READ } qdddrv_command;
typedef struct {
  void *context;
  uint32_t first_id;
  /* Reply is already bounded/parsed. 0 means timeout/retry; -1 fatal/cancel. */
  int (*exchange)(void *, qdddrv_command, uint32_t, const char *, uint32_t, uint32_t, qdddrv_reply *);
  int (*append)(void *, const uint8_t *, uint32_t);
  int (*verify_sha)(void *, const uint8_t *);
  int (*cancelled)(void *);
  void (*progress)(void *, uint32_t, uint32_t);
} qdddrv_io;
typedef enum { QDDDRV_TRANSFER_OK, QDDDRV_TRANSFER_CANCELLED, QDDDRV_TRANSFER_IO,
               QDDDRV_TRANSFER_PROTOCOL, QDDDRV_TRANSFER_SHA } qdddrv_result;
qdddrv_result qdddrv_transfer(const qdddrv_io *io, qdddrv_reply *info);
#endif
