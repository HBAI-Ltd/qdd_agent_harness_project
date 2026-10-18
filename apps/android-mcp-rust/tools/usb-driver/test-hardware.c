#include "hardware.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int match_ascii(const char *text, size_t size) {
  uint16_t hardware[1024];
  assert(size <= sizeof(hardware) / sizeof(hardware[0]));
  for (size_t i = 0; i < size; ++i) hardware[i] = (unsigned char)text[i];
  return qdddrv_usb_hardware_match(hardware, size * sizeof(hardware[0]));
}

#define MATCH(text) match_ascii((text), sizeof(text))

int main(void) {
  assert(MATCH("USB\\VID_303A&PID_1001\0"));
  assert(MATCH("usb\\vid_303a&pid_1001\0"));
  assert(MATCH("USB\\VID_303A&PID_1001&REV_0101\0"));
  assert(MATCH("USB\\VID_303A&PID_1001&REV_0101&MI_00\0"));
  assert(MATCH("USB\\VID_303A&PID_1001&MI_00\0USB\\VID_303A&PID_1001\0"));
  assert(MATCH("USB\\VID_1234&PID_5678\0USB\\VID_303A&PID_1001\0"));
  assert(!MATCH("USB\\VID_303A&PID_10010\0"));
  assert(!MATCH("USB\\VID_303A&PID_1001JUNK\0"));
  assert(!MATCH("JUNKUSB\\VID_303A&PID_1001\0"));
  assert(!MATCH("BTHENUM\\VID_303A&PID_1001\0"));
  assert(!MATCH("USB\\VID_1303A&PID_1001\0"));
  assert(!MATCH("USB\\VID_303A0&PID_1001\0"));
  assert(!MATCH("USB\\VID_303B&PID_1001\0"));
  assert(!MATCH("USB\\VID_303A&PID_1002\0"));
  assert(!MATCH("USB\\VID_303A&PID_1001"));
  assert(!MATCH("USB\\VID_303A&PID_1001\0\0garbage\0"));
  assert(!MATCH("\0USB\\VID_303A&PID_1001\0"));
  assert(!MATCH("USB\\VID_1234&PID_5678\0\0USB\\VID_303A&PID_1001\0"));
  assert(!MATCH("\0"));
  uint16_t hardware[32] = {0};
  const char *valid = "USB\\VID_303A&PID_1001";
  for (size_t i = 0; i < strlen(valid); ++i) hardware[i] = (unsigned char)valid[i];
  const size_t bytes = (strlen(valid) + 2u) * sizeof(hardware[0]);
  assert(qdddrv_usb_hardware_match(hardware, bytes));
  assert(!qdddrv_usb_hardware_match(hardware, bytes - 1u));
  assert(!qdddrv_usb_hardware_match(hardware, bytes - 2u));
  assert(!qdddrv_usb_hardware_match(hardware, 0));
  assert(!qdddrv_usb_hardware_match(hardware, 2));
  assert(!qdddrv_usb_hardware_match(hardware, 2050));
  hardware[strlen(valid) + 1u] = 'X';
  assert(!qdddrv_usb_hardware_match(hardware, bytes));
  puts("USB downloader exact VID/PID REG_MULTI_SZ boundaries: 26 scenarios PASS");
  return 0;
}
