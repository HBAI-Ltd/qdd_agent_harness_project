#include "qdd_alloc_trace.h"
#include "esp_attr.h"
#include <inttypes.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

// No task lookup, allocation, logging, or payload reads in a failed allocation.
// State 0/1/2 means unclaimed/writing/published; only the first complete record
// is retained for this boot. SDK failed-allocation hooks run inside __real_*
// before these wrappers see NULL, so their first records need not be identical.
static atomic_uint s_state, s_count, s_kind, s_size, s_caps;
static atomic_uintptr_t s_pc;

void *__real_malloc(size_t size);
void *__real_calloc(size_t count, size_t size);
void *__real_heap_caps_malloc(size_t size, uint32_t caps);

static void IRAM_ATTR __attribute__((noinline, no_instrument_function))
record_failure(unsigned kind, size_t size, uint32_t caps, uintptr_t pc) {
    atomic_fetch_add(&s_count, 1u);
    unsigned empty = 0;
    if (!atomic_compare_exchange_strong(&s_state, &empty, 1u)) return;
#if SIZE_MAX > UINT32_MAX
    if (size > UINT32_MAX) size = UINT32_MAX;
#endif
    atomic_store(&s_kind, kind);
    atomic_store(&s_size, (uint32_t)size);
    atomic_store(&s_caps, caps);
    atomic_store(&s_pc, pc);
    atomic_store(&s_state, 2u);
}

void *IRAM_ATTR __attribute__((noinline, no_instrument_function))
__wrap_malloc(size_t size) {
    void *result = __real_malloc(size);
    if (!result && size) record_failure(1u, size, 0u,
        (uintptr_t)__builtin_extract_return_addr(__builtin_return_address(0)));
    return result;
}

void *IRAM_ATTR __attribute__((noinline, no_instrument_function))
__wrap_calloc(size_t count, size_t size) {
    void *result = __real_calloc(count, size);
    if (!result && count && size) {
        const size_t bytes = size > SIZE_MAX / count ? SIZE_MAX : count * size;
        record_failure(2u, bytes, 0u,
            (uintptr_t)__builtin_extract_return_addr(__builtin_return_address(0)));
    }
    return result;
}

void *IRAM_ATTR __attribute__((noinline, no_instrument_function))
__wrap_heap_caps_malloc(size_t size, uint32_t caps) {
    void *result = __real_heap_caps_malloc(size, caps);
    if (!result && size) record_failure(3u, size, caps,
        (uintptr_t)__builtin_extract_return_addr(__builtin_return_address(0)));
    return result;
}

size_t qdd_alloc_trace_diagnostics(char *out, size_t capacity) {
    if (!out || !capacity) return 0;
    out[0] = 0;
    const bool ready = atomic_load(&s_state) == 2u;
    const size_t limit = capacity < QDD_ALLOC_TRACE_MAX + 1u ? capacity : QDD_ALLOC_TRACE_MAX + 1u;
    const int length = snprintf(out, limit,
        "{\"count\":%u,\"ready\":%s,\"kind\":%u,\"pc\":%" PRIuPTR ",\"size\":%u,\"caps\":%u}",
        atomic_load(&s_count), ready ? "true" : "false",
        ready ? atomic_load(&s_kind) : 0u, ready ? atomic_load(&s_pc) : (uintptr_t)0,
        ready ? atomic_load(&s_size) : 0u, ready ? atomic_load(&s_caps) : 0u);
    if (length <= 0 || (size_t)length >= limit) { out[0] = 0; return 0; }
    return (size_t)length;
}
