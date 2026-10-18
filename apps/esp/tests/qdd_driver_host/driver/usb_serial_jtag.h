#pragma once
#include <stddef.h>
#include "freertos/FreeRTOS.h"
int usb_serial_jtag_write_bytes(const void *bytes, size_t length, unsigned ticks);
