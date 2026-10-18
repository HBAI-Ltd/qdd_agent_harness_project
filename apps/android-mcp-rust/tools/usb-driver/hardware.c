#include "hardware.h"
static uint16_t upper(uint16_t value) { return value >= 'a' && value <= 'z' ? value - 'a' + 'A' : value; }
int qdddrv_usb_hardware_match(const uint16_t *hardware, size_t bytes) {
  const char prefix[] = "USB\\VID_303A&PID_1001";
  const size_t size = bytes / 2u, prefix_size = sizeof(prefix) - 1u;
  if (!hardware || (bytes & 1u) || bytes < 4u || bytes > 2048u || hardware[size - 1u] || hardware[size - 2u]) return 0;
  size_t offset = 0; int matched = 0;
  while (offset + 1u < size) {
    if (!hardware[offset]) return offset == size - 2u ? matched : 0;
    size_t end = offset;
    while (end < size && hardware[end]) ++end;
    if (end >= size) return 0;
    if (end - offset >= prefix_size) {
      size_t i = 0;
      while (i < prefix_size && upper(hardware[offset + i]) == (uint16_t)prefix[i]) ++i;
      if (i == prefix_size && (end - offset == prefix_size || hardware[offset + prefix_size] == '&')) matched = 1;
    }
    offset = end + 1u;
  }
  return offset == size - 1u ? matched : 0;
}
