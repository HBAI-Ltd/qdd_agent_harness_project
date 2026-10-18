// Bounded first failed wrapped allocator caller; not a backtrace or heap trace.
#pragma once
#include <stddef.h>
#define QDD_ALLOC_TRACE_MAX 128u
// kind: 1 malloc, 2 calloc, 3 heap_caps_malloc. caps=0 means no caps argument.
// Numeric PC is a code return address, to decode only with the exact flashed ELF.
size_t qdd_alloc_trace_diagnostics(char *out, size_t capacity);
