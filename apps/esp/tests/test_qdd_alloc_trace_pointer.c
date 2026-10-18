#include <stddef.h>
#include <stdint.h>
void *heap_caps_malloc(size_t size, uint32_t caps);
// Like esp_adapter's allocator table: an undefined external function address
// in another translation unit, not a direct wrapper call.
static void *(*volatile s_allocator)(size_t, uint32_t) = heap_caps_malloc;
void *qdd_alloc_pointer_probe(size_t size, uint32_t caps) { return s_allocator(size, caps); }
