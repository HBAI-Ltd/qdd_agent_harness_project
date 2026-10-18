// Exercise the production BSP with a bounded mock DMA allocator and flushes.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../components/bsp/src/bsp_display_lvgl.c"

#ifdef QDD_BSP_BASELINE_ROWS
// The old BSP has no configurable entry point: reproduce its fixed allocation.
#define init_rows(rows) ((void)(rows), bsp_lvgl_init())
#else
#define init_rows(rows) bsp_lvgl_init_with_buffer_rows(rows)
#endif

static lv_display_t display;
static int panel_token, io_token, init_calls, add_calls, lock_depth;
static size_t dma_budget = (size_t)BSP_LCD_W * BSP_LCD_H * sizeof(uint16_t);
static size_t requested_bytes, allocated_bytes;
static uint32_t callback_count;
static uint8_t *dma_buffer;

esp_lcd_panel_handle_t bsp_display_panel(void) { return &panel_token; }
esp_lcd_panel_io_handle_t bsp_display_io(void) { return &io_token; }
esp_err_t lvgl_port_init(const lvgl_port_cfg_t *cfg) {
    (void)cfg;
    ++init_calls;
    return ESP_OK;
}
bool lvgl_port_lock(uint32_t timeout) { (void)timeout; ++lock_depth; return true; }
void lvgl_port_unlock(void) { assert(lock_depth > 0); --lock_depth; }
lv_display_t *lvgl_port_add_disp(const lvgl_port_display_cfg_t *cfg) {
    assert(lock_depth && cfg->panel_handle == &panel_token && cfg->io_handle == &io_token);
    assert(cfg->hres == BSP_LCD_W && cfg->vres == BSP_LCD_H);
    assert(cfg->flags.buff_dma && cfg->flags.swap_bytes && !cfg->double_buffer);
    assert(!cfg->flags.buff_spiram && !cfg->flags.sw_rotate);
    ++add_calls;
    // The real port defaults to RGB565 and allocates buffer_size * color_bytes
    // with MALLOC_CAP_DMA. Model that single allocation's admission budget.
    requested_bytes = (size_t)cfg->buffer_size * sizeof(uint16_t);
    if (requested_bytes > dma_budget) return NULL;
    assert(!dma_buffer);
    dma_buffer = malloc(requested_bytes);
    assert(dma_buffer);
    allocated_bytes = requested_bytes;
    return &display;
}
esp_err_t lvgl_port_remove_disp(lv_display_t *disp) {
    assert(disp == &display && lock_depth);
    free(dma_buffer);
    dma_buffer = NULL;
    allocated_bytes = 0;
    return ESP_OK;
}
void lv_display_add_event_cb(lv_display_t *disp, void (*cb)(lv_event_t *), int code, void *user) {
    (void)user;
    assert(lock_depth && disp == &display && cb == rounded_flush_event && code == LV_EVENT_FLUSH_START);
    ++callback_count;
}
uint32_t lv_display_get_event_count(lv_display_t *disp) {
    assert(lock_depth && disp == &display);
    return callback_count;
}

static void check_flush(int x1, int width, int y1, int rows) {
    const int stride = width + 4;
    const size_t count = (size_t)stride * rows + 2;
    uint16_t *pixels = malloc(count * sizeof(uint16_t));
    assert(pixels);
    for (size_t i = 0; i < count; ++i) pixels[i] = 0x55aa;
    for (int y = 0; y < rows; ++y) {
        for (int x = 0; x < width; ++x) pixels[1 + y * stride + x] = 0x1234;
    }
    display.buffer = (lv_draw_buf_t){ .data = (uint8_t *)(pixels + 1),
                                    .header.stride = (uint32_t)stride * sizeof(uint16_t) };
    lv_area_t area = { .x1 = x1, .y1 = y1, .x2 = x1 + width - 1, .y2 = y1 + rows - 1 };
    lv_event_t event = { .target = &display, .area = &area };
    rounded_flush_event(&event);
    assert(pixels[0] == 0x55aa && pixels[count - 1] == 0x55aa);
    for (int y = 0; y < rows; ++y) {
        for (int x = 0; x < width; ++x) {
            const bool outside = bsp_display_pixel_outside_rounded_rect(
                x1 + x, y1 + y, BSP_LCD_W, BSP_LCD_H, BSP_LVGL_SCREEN_RADIUS);
            assert(pixels[1 + y * stride + x] == (outside ? 0 : 0x1234));
        }
        for (int x = width; x < stride; ++x) assert(pixels[1 + y * stride + x] == 0x55aa);
    }
    free(pixels);
}

int main(int argc, char **argv) {
    assert(argc == 2);
    if (!strcmp(argv[1], "budget")) {
        dma_budget = (size_t)BSP_LCD_W * 20u * sizeof(uint16_t);
        assert(init_rows(20) == &display);
        assert(allocated_bytes == 9600u);
    } else if (!strcmp(argv[1], "default")) {
        assert(bsp_lvgl_init() == &display);
        assert(allocated_bytes == (size_t)BSP_LCD_W * 40u * sizeof(uint16_t));
    } else if (!strcmp(argv[1], "min") || !strcmp(argv[1], "max")) {
        const uint16_t rows = !strcmp(argv[1], "min") ? 1 : BSP_LCD_H;
        assert(init_rows(rows) == &display);
        assert(allocated_bytes == (size_t)BSP_LCD_W * rows * sizeof(uint16_t));
    } else if (!strcmp(argv[1], "invalid")) {
        assert(init_rows(0) == NULL);
        assert(init_rows(BSP_LCD_H + 1) == NULL);
        assert(init_rows(UINT16_MAX) == NULL);
        assert(init_calls == 0 && add_calls == 0 && !lock_depth && !dma_buffer);
        assert(init_rows(20) == &display);
        assert(init_rows(0) == NULL && init_rows(BSP_LCD_H + 1) == NULL);
        assert(init_calls == 1 && add_calls == 1);
    } else if (!strcmp(argv[1], "retry")) {
        dma_budget = (size_t)BSP_LCD_W * 20u * sizeof(uint16_t);
        assert(bsp_lvgl_init() == NULL); // Legacy allocation exceeds budget.
        assert(requested_bytes == 19200u && allocated_bytes == 0 && !s_disp && !lock_depth);
        assert(init_rows(20) == &display); // Reuses the already initialized port.
        assert(init_calls == 1 && add_calls == 2 && allocated_bytes == 9600u);
        assert(bsp_lvgl_init() == &display && init_rows(BSP_LCD_H) == &display);
        assert(add_calls == 2 && allocated_bytes == 9600u); // No hot reallocation.
    } else if (!strcmp(argv[1], "rounding")) {
        assert(init_rows(20) == &display);
        // Compare every pixel with the full-screen rounded mask, including
        // strip boundaries at 20/40 lines, both corner bands and padded stride.
        for (int y = 0; y < BSP_LCD_H; y += 20) check_flush(0, BSP_LCD_W, y, 20);
        for (int y = 0; y < BSP_LCD_H; y += 40) check_flush(0, BSP_LCD_W, y, 40);
        check_flush(5, 60, 0, 20);
        check_flush(BSP_LCD_W - 65, 60, BSP_LCD_H - 20, 20);
        check_flush(0, 1, 29, 1);
        check_flush(BSP_LCD_W - 1, 1, BSP_LCD_H - 1, 1);
    } else {
        assert(false && "Unknown scenario");
    }
    assert(!lock_depth);
    free(dma_buffer);
    puts("BSP bounded DMA draw buffer tests: PASS");
    return 0;
}
