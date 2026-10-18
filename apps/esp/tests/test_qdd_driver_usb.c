#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

#include "../main/qdd_driver_usb.c"

static uint8_t fixture[5000];
static uint64_t test_ms;
static char captured[32768];
static size_t captured_length;
static unsigned open_count, read_count, tx_count, fail_after, claim_count, release_count;
static bool resource_claimed, open_fail, read_fail, create_fail, disconnect_hash, cancel_tx, queue_during_tx;
static bool expect_reserved_during_cleanup;
static bool late_cancel_after_data;
static int lock_depth;
static const esp_partition_t partition = {.size = 8192};

void qdd_test_enter_critical(portMUX_TYPE *lock) { (void)lock; assert(!lock_depth); lock_depth++; }
void qdd_test_exit_critical(portMUX_TYPE *lock) {
    (void)lock; assert(lock_depth == 1); lock_depth--;
    // Exact preemption after the terminal DATA frame: main priority 6 can run
    // at this critical-section exit before the priority-5 worker resumes.
    if (late_cancel_after_data && captured_length && captured[captured_length - 1] == '\n' && strstr(captured, " DATA ")) {
        late_cancel_after_data = false;
        qdd_driver_command_t cancel = {.id = 99, .operation = QDD_DRIVER_CANCEL};
        memcpy(cancel.session, s_session, sizeof(cancel.session));
        qdd_driver_usb_submit(&cancel);
    }
}
void qdd_test_yield(void) {}
int64_t esp_timer_get_time(void) { return (int64_t)test_ms * 1000; }
uint32_t esp_random(void) { return 0x1234ab00u + open_count; }
void vTaskDelay(unsigned ticks) { assert(!lock_depth); test_ms += ticks; }
void vTaskDelete(TaskHandle_t task) { (void)task; }
int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack, void *ctx, unsigned priority, TaskHandle_t *handle) {
    (void)entry; (void)name; (void)ctx; (void)handle;
    assert(stack == 4096 && priority == 5);
    return create_fail ? 0 : pdPASS;
}
bool qdd_download_assets_claim(void) {
    if (resource_claimed) return false;
    resource_claimed = true; claim_count++; return true;
}
void qdd_download_assets_release(void) { assert(resource_claimed); resource_claimed = false; release_count++; }
esp_err_t qdd_download_assets_open(qdd_download_asset_t *asset, bool (*cancel)(void), void *buffer, size_t size) {
    assert(!lock_depth && buffer == s_staging && size == 2048);
    open_count++;
    if (disconnect_hash) qdd_driver_usb_tick(false, false);
    if (open_fail || cancel()) return ESP_FAIL;
    asset->partition = &partition; asset->size = sizeof(fixture); asset->kind = QDD_DOWNLOAD_ZIP;
    memset(asset->sha256, 'a', 64); asset->sha256[64] = 0;
    return ESP_OK;
}
esp_err_t qdd_download_assets_read(const qdd_download_asset_t *asset, size_t offset, void *buffer, size_t length) {
    assert(!lock_depth && buffer == s_staging && asset->partition == &partition);
    assert(offset <= sizeof(fixture) && length <= sizeof(fixture) - offset);
    read_count++;
    if (read_fail) return ESP_FAIL;
    memcpy(buffer, fixture + offset, length); return ESP_OK;
}
int usb_serial_jtag_write_bytes(const void *bytes, size_t length, unsigned ticks) {
    (void)ticks;
    assert(!lock_depth && length <= 512);
    if (expect_reserved_during_cleanup) assert(qdd_driver_usb_reserved() && resource_claimed);
    tx_count++;
    if (queue_during_tx) {
        queue_during_tx = false;
        assert(qdd_driver_usb_reply("NEUTRAL\n", 8));
    }
    if (cancel_tx) {
        cancel_tx = false;
        qdd_driver_command_t cancel = {.id = 99, .operation = QDD_DRIVER_CANCEL};
        memcpy(cancel.session, s_session, sizeof(cancel.session));
        qdd_driver_usb_submit(&cancel);
    }
    if (fail_after && tx_count >= fail_after) { test_ms += 10; return 0; }
    assert(captured_length + length < sizeof(captured));
    memcpy(captured + captured_length, bytes, length); captured_length += length; captured[captured_length] = 0;
    return (int)length;
}

static void reset(void) {
    memset(&s_asset, 0, sizeof(s_asset)); memset(s_session, 0, sizeof(s_session));
    memset(&s_command, 0, sizeof(s_command));
    atomic_store(&s_online, false); atomic_store(&s_control_busy, false);
    atomic_store(&s_reserved, false); atomic_store(&s_cancel, false);
    atomic_store(&s_reply_failed, false);
    s_started = s_busy = s_pending = s_claimed = false; s_cancel_reply = 0;
    s_reply_head = s_reply_count = 0; s_activity_ms = 0;
    memset(&s_view, 0, sizeof(s_view));
    test_ms = 100; captured_length = 0; captured[0] = 0;
    open_count = read_count = tx_count = fail_after = claim_count = release_count = 0;
    resource_claimed = open_fail = read_fail = create_fail = disconnect_hash = cancel_tx = queue_during_tx = false;
    expect_reserved_during_cleanup = false;
    late_cancel_after_data = false;
    for (size_t i = 0; i < sizeof(fixture); i++) fixture[i] = (uint8_t)(i * 37u);
    assert(qdd_driver_usb_start() == ESP_OK); qdd_driver_usb_tick(true, false);
}
static void clear_capture(void) { captured_length = tx_count = 0; captured[0] = 0; }
static void submit(const char *line) {
    qdd_driver_command_t command; assert(qdd_driver_parse(line, &command)); qdd_driver_usb_submit(&command);
}
static void info(void) {
    submit("QDDDRV/1 1 INFO"); assert(qdd_driver_usb_reserved() && s_busy);
    // Main admission does no Flash/TX; the reservation already exists.
    assert(!open_count && !tx_count); worker_once();
    assert(open_count == 1 && !s_busy && s_session[0] && resource_claimed);
    assert(strstr(captured, "QDDDRV/1 1 INFO ")); clear_capture();
}
static void read_request(unsigned id, uint32_t offset, unsigned length) {
    char line[128]; snprintf(line, sizeof(line), "QDDDRV/1 %u READ %s %lu %u", id, s_session, (unsigned long)offset, length);
    submit(line);
}

static void test_transfer(void) {
    reset(); info();
    read_request(2, 1024, 1024); assert(read_count == 0); queue_during_tx = true; worker_once();
    assert(read_count == 1 && open_count == 1 && tx_count >= 9);
    char expected[QDD_DRIVER_FRAME_MAX];
    size_t expected_size = qdd_driver_format_data(expected, sizeof(expected), 2, s_session, 1024, fixture + 1024, 1024);
    assert(captured_length == expected_size + 8 && !memcmp(captured, expected, expected_size));
    assert(!strcmp(captured + expected_size, "NEUTRAL\n"));
    clear_capture(); read_request(2, 1024, 1024); worker_once();
    assert(captured_length == expected_size && !memcmp(captured, expected, expected_size));
    assert(read_count == 2 && open_count == 1); // Replay is only the same immutable bytes.
    clear_capture(); read_request(3, UINT32_MAX, 1024); worker_once();
    assert(!strcmp(captured, "QDDDRV/1 3 ERR BAD_RANGE\n") && qdd_driver_usb_reserved());
    clear_capture(); submit("QDDDRV/1 4 READ ffffffffffffffff 0 1"); worker_once();
    assert(!strcmp(captured, "QDDDRV/1 4 ERR STALE_SESSION\n") && qdd_driver_usb_reserved());
    clear_capture(); char line[80]; snprintf(line, sizeof(line), "QDDDRV/1 5 CANCEL %s", s_session); submit(line); worker_once();
    assert(!strcmp(captured, "QDDDRV/1 5 OK\n") && !qdd_driver_usb_reserved() && !resource_claimed && release_count == 1);
}
static void test_failures(void) {
    reset(); qdd_driver_usb_tick(true, true); submit("QDDDRV/1 1 INFO");
    assert(!qdd_driver_usb_reserved() && !open_count); worker_once(); assert(strstr(captured, "CONTROL_BUSY"));
    reset(); resource_claimed = true; submit("QDDDRV/1 1 INFO"); worker_once();
    assert(!qdd_driver_usb_reserved() && !open_count && strstr(captured, "BUSY"));
    reset(); open_fail = true; submit("QDDDRV/1 1 INFO"); worker_once();
    assert(strstr(captured, "ASSET_ERROR") && !qdd_driver_usb_reserved() && !resource_claimed);
    reset(); disconnect_hash = true; submit("QDDDRV/1 1 INFO"); worker_once();
    assert(!qdd_driver_usb_reserved() && !resource_claimed && !captured_length && !s_busy);
    reset(); info(); read_fail = true; expect_reserved_during_cleanup = true; read_request(2, 0, 1); worker_once();
    assert(strstr(captured, "IO_ERROR") && !qdd_driver_usb_reserved() && release_count == 1);
    reset(); info(); read_request(2, 0, 1024); fail_after = 2; worker_once();
    assert(test_ms >= 2100 && test_ms <= 2120 && !qdd_driver_usb_reserved() && !s_busy && release_count == 1);
    reset(); info(); read_request(2, 0, 1024); cancel_tx = true; worker_once();
    assert(strstr(captured, "QDDDRV/1 99 OK\n") && !qdd_driver_usb_reserved() && !s_busy && release_count == 1);
    reset(); info(); qdd_driver_usb_tick(true, true); worker_once();
    assert(!qdd_driver_usb_reserved() && !resource_claimed);
}
static void test_expiry_and_queue(void) {
    reset(); info(); test_ms += QDD_DRIVER_IDLE_MS; worker_once(); assert(qdd_driver_usb_reserved());
    test_ms++; worker_once(); assert(!qdd_driver_usb_reserved() && release_count == 1);
    reset(); info(); test_ms--; worker_once(); assert(!qdd_driver_usb_reserved());
    reset(); info(); test_ms += QDD_DRIVER_IDLE_MS + 1; read_request(2, 0, 1); worker_once();
    assert(strstr(captured, "STALE_SESSION") && !read_count && !qdd_driver_usb_reserved());
    reset(); info(); qdd_driver_usb_tick(false, false); worker_once(); assert(!qdd_driver_usb_reserved());
    reset(); submit("QDDDRV/1 1 INFO"); submit("QDDDRV/1 2 INFO");
    assert(!open_count && s_reply_count == 1); worker_once();
    assert(open_count == 1 && strstr(captured, "QDDDRV/1 2 ERR BUSY\n"));
    reset(); assert(qdd_driver_usb_reply("A\n", 2)); assert(qdd_driver_usb_reply("B\n", 2));
    assert(!qdd_driver_usb_reply("C\n", 2)); worker_once(); worker_once();
    assert(!strcmp(captured, "A\nB\n"));
    reset(); assert(qdd_driver_usb_reply("QDD/1 1 OK\n", 11)); fail_after = 1; worker_once();
    assert(qdd_driver_usb_take_reply_failure() && !qdd_driver_usb_take_reply_failure());
    reset(); s_started = false; create_fail = true; assert(qdd_driver_usb_start() == ESP_ERR_NO_MEM);
}
static void test_late_cancel_cannot_reach_next_session(void) {
    reset(); info(); read_request(2, 0, 1024); late_cancel_after_data = true;
    worker_once();
    assert(!late_cancel_after_data && s_pending && s_busy && !s_cancel_reply);
    assert(qdd_driver_usb_view().transferred_bytes == 1024);
    worker_once();
    assert(strstr(captured, "QDDDRV/1 99 OK\n") && !qdd_driver_usb_reserved() && !s_busy && !s_cancel_reply);
    assert(qdd_driver_usb_view().phase == QDD_DRIVER_USB_CANCELLED);
    clear_capture(); submit("QDDDRV/1 3 INFO");
    assert(qdd_driver_usb_view().phase == QDD_DRIVER_USB_CHECKING && !qdd_driver_usb_view().transferred_bytes);
    worker_once();
    assert(open_count == 2 && qdd_driver_usb_reserved() && s_session[0] && !s_cancel_reply);
    assert(strstr(captured, "QDDDRV/1 3 INFO ") && !strstr(captured, "QDDDRV/1 99"));
}
static void cancel_current(void) {
    char line[80]; snprintf(line, sizeof(line), "QDDDRV/1 90 CANCEL %s", s_session); submit(line); worker_once();
}
static void test_read_only_ui_progress(void) {
    reset();
    qdd_driver_usb_view_t view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_IDLE && !view.total_bytes && !view.transferred_bytes);
    submit("QDDDRV/1 1 INFO"); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_CHECKING && !view.total_bytes && !view.transferred_bytes);
    submit("QDDDRV/1 2 INFO"); assert(qdd_driver_usb_view().phase == QDD_DRIVER_USB_CHECKING);
    worker_once(); clear_capture(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_TRANSFERRING && view.total_bytes == sizeof(fixture) && !view.transferred_bytes);
    read_request(3, 4000, 1000); worker_once(); assert(!qdd_driver_usb_view().transferred_bytes);
    read_request(4, 0, 1024); worker_once(); assert(qdd_driver_usb_view().transferred_bytes == 1024);
    read_request(5, 0, 1024); worker_once(); assert(qdd_driver_usb_view().transferred_bytes == 1024);
    read_request(6, 512, 1024); worker_once(); assert(qdd_driver_usb_view().transferred_bytes == 1536);
    read_request(7, 2048, 1024); worker_once(); assert(qdd_driver_usb_view().transferred_bytes == 1536);
    read_request(8, UINT32_MAX, 1024); worker_once();
    view = qdd_driver_usb_view(); assert(view.phase == QDD_DRIVER_USB_TRANSFERRING && view.transferred_bytes == 1536);
    submit("QDDDRV/1 9 READ ffffffffffffffff 0 1"); worker_once();
    view = qdd_driver_usb_view(); assert(view.phase == QDD_DRIVER_USB_TRANSFERRING && view.transferred_bytes == 1536 && !view.error);
    const uint32_t offsets[] = {1536, 2560, 3584, 4608};
    const unsigned lengths[] = {1024, 1024, 1024, 392};
    for (unsigned i = 0; i < 4; i++) { read_request(10 + i, offsets[i], lengths[i]); worker_once(); }
    view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_SENT && view.transferred_bytes == sizeof(fixture) && view.error == QDD_DRIVER_USB_ERROR_NONE);
    cancel_current(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_SENT && view.transferred_bytes == sizeof(fixture) && !qdd_driver_usb_reserved());
    // Reading/copying a snapshot cannot reset the worker or mutate its lease.
    view.phase = QDD_DRIVER_USB_IDLE; view.transferred_bytes = 0;
    assert(qdd_driver_usb_view().phase == QDD_DRIVER_USB_SENT);
}
static void test_ui_terminal_boundaries(void) {
    reset(); info(); read_request(2, 0, 64); worker_once(); cancel_current();
    qdd_driver_usb_view_t view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_CANCELLED && view.transferred_bytes == 64 && view.total_bytes == sizeof(fixture));
    reset(); open_fail = true; submit("QDDDRV/1 1 INFO"); worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_ASSET && !view.transferred_bytes);
    reset(); info(); read_fail = true; read_request(2, 0, 64); worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_IO && !view.transferred_bytes);
    reset(); info(); read_request(2, 0, 1024); fail_after = 2; worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_IO && !view.transferred_bytes);
    reset(); info(); read_request(2, 0, 1024); cancel_tx = true; worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_CANCELLED && !view.transferred_bytes);
    reset(); info(); test_ms += QDD_DRIVER_IDLE_MS + 1; worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_EXPIRED);
    reset(); info(); test_ms--; worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_CLOCK);
    reset(); info(); qdd_driver_usb_tick(false, false); worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_DISCONNECTED);
    reset(); info(); qdd_driver_usb_tick(true, true); worker_once(); view = qdd_driver_usb_view();
    assert(view.phase == QDD_DRIVER_USB_ERROR && view.error == QDD_DRIVER_USB_ERROR_CONTROL);
}
int main(void) {
    test_transfer(); test_failures(); test_expiry_and_queue(); test_late_cancel_cannot_reach_next_session();
    test_read_only_ui_progress(); test_ui_terminal_boundaries();
    puts("USB driver worker: PASS (read-only offset/CRC, admission, serialized TX, cleanup, TTL)");
    return 0;
}
