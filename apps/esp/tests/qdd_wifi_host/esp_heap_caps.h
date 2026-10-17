#pragma once
#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
#define MALLOC_CAP_8BIT (1u << 2)
#define MALLOC_CAP_INTERNAL (1u << 11)
typedef void (*esp_alloc_failed_hook_t)(size_t, uint32_t, const char *);
esp_err_t heap_caps_register_failed_alloc_callback(esp_alloc_failed_hook_t callback);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_minimum_free_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);
