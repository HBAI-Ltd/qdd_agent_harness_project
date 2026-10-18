#ifndef QDD_USB_DRIVER_HARDWARE_H
#define QDD_USB_DRIVER_HARDWARE_H
#include <stddef.h>
#include <stdint.h>
/* Registry REG_MULTI_SZ UTF-16, exact USB VID/PID component boundaries. */
int qdddrv_usb_hardware_match(const uint16_t *hardware, size_t bytes);
#endif
