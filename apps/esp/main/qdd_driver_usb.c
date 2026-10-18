#include "qdd_driver_usb.h"

#include "driver/usb_serial_jtag.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "qdd_download_assets.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#define USB_TX_DEADLINE_MS 2000u
#define USB_TX_PORTION 256u
#define USB_REPLY_SLOTS 2u

static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static atomic_bool s_online, s_control_busy, s_reserved, s_cancel;
static atomic_bool s_reply_failed;
static bool s_started, s_busy, s_pending, s_claimed;
static uint32_t s_cancel_reply;
static qdd_driver_command_t s_command;
static qdd_download_asset_t s_asset;
static char s_session[17];
static uint64_t s_activity_ms;
static uint32_t s_session_sequence;
static uint8_t s_staging[QDD_DOWNLOAD_ASSET_CHUNK_SIZE];
static char s_frame[QDD_DRIVER_FRAME_MAX];
static char s_replies[USB_REPLY_SLOTS][QDD_DRIVER_USB_REPLY_MAX];
static size_t s_reply_lengths[USB_REPLY_SLOTS];
static unsigned s_reply_head, s_reply_count;
static qdd_driver_usb_view_t s_view;

qdd_driver_usb_view_t qdd_driver_usb_view(void) {
    portENTER_CRITICAL(&s_lock);
    const qdd_driver_usb_view_t view = s_view;
    portEXIT_CRITICAL(&s_lock);
    return view;
}

static uint64_t clock_ms(void) { return (uint64_t)esp_timer_get_time() / 1000u; }

static bool cancelled(void) {
    return atomic_load(&s_cancel) || !atomic_load(&s_online) || atomic_load(&s_control_busy);
}

static qdd_driver_usb_error_t failure_reason(qdd_driver_usb_error_t fallback) {
    if (!atomic_load(&s_online)) return QDD_DRIVER_USB_ERROR_DISCONNECTED;
    if (atomic_load(&s_control_busy)) return QDD_DRIVER_USB_ERROR_CONTROL;
    return fallback;
}

static void view_cancelled_locked(void) {
    if (s_view.phase != QDD_DRIVER_USB_SENT) {
        s_view.phase = QDD_DRIVER_USB_CANCELLED;
        s_view.error = QDD_DRIVER_USB_ERROR_NONE;
    }
}

static void view_failed_locked(qdd_driver_usb_error_t error) {
    if (!atomic_load(&s_reserved)) return;
    if (s_cancel_reply && s_view.phase != QDD_DRIVER_USB_SENT) view_cancelled_locked();
    else {
        s_view.phase = QDD_DRIVER_USB_ERROR;
        s_view.error = error;
    }
}

// The worker alone owns asset bytes/session, while the lock protects the small
// main-loop admission decision. No native I/O runs inside this critical section.
static void clear_session_locked(void) {
    memset(&s_asset, 0, sizeof(s_asset));
    memset(s_session, 0, sizeof(s_session));
    s_activity_ms = 0;
    // A failed/cancelled transfer still owns its frame until TX cleanup ends.
    // Do not admit a new controller or HTTP worker ahead of the terminal reply.
    if (!s_busy) {
        if (s_claimed) { qdd_download_assets_release(); s_claimed = false; }
        atomic_store(&s_reserved, false);
    }
}

static void fail_session(qdd_driver_usb_error_t error) {
    portENTER_CRITICAL(&s_lock);
    view_failed_locked(error);
    clear_session_locked();
    portEXIT_CRITICAL(&s_lock);
}

static void cancel_session(void) {
    portENTER_CRITICAL(&s_lock);
    view_cancelled_locked();
    clear_session_locked();
    portEXIT_CRITICAL(&s_lock);
}

bool qdd_driver_usb_reserved(void) { return atomic_load(&s_reserved); }
bool qdd_driver_usb_take_reply_failure(void) { return atomic_exchange(&s_reply_failed, false); }

void qdd_driver_usb_tick(bool usb_connected, bool control_busy) {
    atomic_store(&s_online, usb_connected);
    atomic_store(&s_control_busy, control_busy);
    if (!usb_connected || control_busy) atomic_store(&s_cancel, true);
}

bool qdd_driver_usb_reply(const char *reply, size_t length) {
    if (!reply || !length || length >= QDD_DRIVER_USB_REPLY_MAX) return false;
    bool queued = false;
    portENTER_CRITICAL(&s_lock);
    if (s_started && s_reply_count < USB_REPLY_SLOTS) {
        const unsigned slot = (s_reply_head + s_reply_count) % USB_REPLY_SLOTS;
        memcpy(s_replies[slot], reply, length);
        s_reply_lengths[slot] = length;
        s_reply_count++;
        queued = true;
    }
    portEXIT_CRITICAL(&s_lock);
    return queued;
}

static void queue_error(uint32_t id, const char *error) {
    char reply[96];
    const size_t length = qdd_driver_format_error(reply, sizeof(reply), id, error);
    (void)qdd_driver_usb_reply(reply, length);
}

void qdd_driver_usb_submit(const qdd_driver_command_t *command) {
    if (!command) return;
    const char *error = NULL;
    portENTER_CRITICAL(&s_lock);
    if (!s_started || !atomic_load(&s_online)) error = "IO_ERROR";
    else if (atomic_load(&s_control_busy)) error = "CONTROL_BUSY";
    else if (command->operation == QDD_DRIVER_CANCEL && s_busy && s_session[0] &&
            !strcmp(command->session, s_session) && !s_cancel_reply) {
        s_cancel_reply = command->id;
        atomic_store(&s_cancel, true);
    } else if (s_busy) error = "BUSY";
    else if (command->operation == QDD_DRIVER_INFO && !s_claimed && !qdd_download_assets_claim()) error = "BUSY";
    else {
        if (command->operation == QDD_DRIVER_INFO) {
            s_claimed = true;
            // Reserve before returning to the parser: a PING/ARM later in the
            // same 64-byte input batch cannot establish a controller.
            atomic_store(&s_reserved, true);
            s_view = (qdd_driver_usb_view_t){.phase = QDD_DRIVER_USB_CHECKING};
        }
        atomic_store(&s_cancel, false);
        s_command = *command;
        s_pending = s_busy = true;
    }
    portEXIT_CRITICAL(&s_lock);
    if (error) queue_error(command->id, error);
}

// Native TX ring is only 1024 bytes. Never submit the >2 KiB DATA line as one
// ring item. One worker serializes all replies, including neutral diagnostics.
static bool write_frame(const char *frame, size_t length, bool check_cancel) {
    const uint64_t start = clock_ms();
    for (size_t offset = 0; offset < length;) {
        const uint64_t now = clock_ms();
        if (!atomic_load(&s_online) || (check_cancel && cancelled()) ||
                now < start || now - start >= USB_TX_DEADLINE_MS) return false;
        const size_t remaining = length - offset;
        const size_t portion = remaining < USB_TX_PORTION ? remaining : USB_TX_PORTION;
        const int sent = usb_serial_jtag_write_bytes(frame + offset, portion, pdMS_TO_TICKS(10));
        if (sent < 0 || (size_t)sent > portion) return false;
        if (sent > 0) offset += (size_t)sent;
        else vTaskDelay(pdMS_TO_TICKS(1));
    }
    return true;
}

static void expire_session(void) {
    const uint64_t now = clock_ms();
    portENTER_CRITICAL(&s_lock);
    if (!s_busy && atomic_load(&s_reserved) && (cancelled() || now < s_activity_ms ||
            now - s_activity_ms > QDD_DRIVER_IDLE_MS)) {
        view_failed_locked(failure_reason(now < s_activity_ms ? QDD_DRIVER_USB_ERROR_CLOCK : QDD_DRIVER_USB_ERROR_EXPIRED));
        clear_session_locked();
    }
    portEXIT_CRITICAL(&s_lock);
}

static void process_command(const qdd_driver_command_t *command) {
    const char *error = NULL;
    size_t length = 0;
    const uint64_t now = clock_ms();
    if (command->operation != QDD_DRIVER_INFO && s_session[0] &&
            (now < s_activity_ms || now - s_activity_ms > QDD_DRIVER_IDLE_MS))
        fail_session(now < s_activity_ms ? QDD_DRIVER_USB_ERROR_CLOCK : QDD_DRIVER_USB_ERROR_EXPIRED);
    if (cancelled()) error = "IO_ERROR";
    else if (command->operation == QDD_DRIVER_INFO) {
        // INFO supersedes any prior idle session. Resources are immutable for
        // the lifetime of this boot; only INFO computes the complete digest.
        portENTER_CRITICAL(&s_lock);
        memset(&s_asset, 0, sizeof(s_asset));
        memset(s_session, 0, sizeof(s_session));
        portEXIT_CRITICAL(&s_lock);
        if (qdd_download_assets_open(&s_asset, cancelled, s_staging, sizeof(s_staging)) != ESP_OK ||
                s_asset.kind != QDD_DOWNLOAD_ZIP || s_asset.size > QDD_DRIVER_ASSET_MAX) error = "ASSET_ERROR";
        else {
            const uint32_t nonce_high = esp_random();
            s_session_sequence++;
            if (!s_session_sequence) s_session_sequence++;
            uint32_t nonce_low = esp_random() ^ s_session_sequence;
            if (!nonce_high && !nonce_low) nonce_low = s_session_sequence;
            portENTER_CRITICAL(&s_lock);
            (void)snprintf(s_session, sizeof(s_session), "%08lx%08lx", (unsigned long)nonce_high,
                (unsigned long)nonce_low);
            s_view = (qdd_driver_usb_view_t){.phase = QDD_DRIVER_USB_TRANSFERRING, .total_bytes = s_asset.size};
            portEXIT_CRITICAL(&s_lock);
            length = qdd_driver_format_info(s_frame, sizeof(s_frame), command->id,
                s_session, s_asset.size, s_asset.sha256);
        }
    } else if (!s_session[0] || strcmp(command->session, s_session)) error = "STALE_SESSION";
    else if (command->operation == QDD_DRIVER_CANCEL) {
        cancel_session();
        length = qdd_driver_format_ok(s_frame, sizeof(s_frame), command->id);
    } else if (command->operation == QDD_DRIVER_READ) {
        if (!command->length || command->length > QDD_DRIVER_READ_MAX ||
                command->offset > s_asset.size || command->length > s_asset.size - command->offset) error = "BAD_RANGE";
        else if (qdd_download_assets_read(&s_asset, command->offset, s_staging, command->length) != ESP_OK) error = "IO_ERROR";
        else length = qdd_driver_format_data(s_frame, sizeof(s_frame), command->id,
                s_session, command->offset, s_staging, command->length);
    } else error = "BAD_COMMAND";

    if (!error && (!length || cancelled())) error = "IO_ERROR";
    if (error) {
        // Invalid offset/session is a rejected read, not a mutable seek. Keep
        // the current valid session available for a corrected request.
        if (!strcmp(error, "ASSET_ERROR") || !strcmp(error, "IO_ERROR"))
            fail_session(failure_reason(!strcmp(error, "ASSET_ERROR") ? QDD_DRIVER_USB_ERROR_ASSET : QDD_DRIVER_USB_ERROR_IO));
        length = qdd_driver_format_error(s_frame, sizeof(s_frame), command->id, error);
    }
    const bool written = length && write_frame(s_frame, length, !error && command->operation != QDD_DRIVER_CANCEL);
    if (!written) {
        fail_session(failure_reason(QDD_DRIVER_USB_ERROR_IO));
        // A bounded best-effort delimiter lets a reconnected client discard a
        // partial ASCII frame rather than joining it to the next response.
        if (atomic_load(&s_online)) (void)usb_serial_jtag_write_bytes("\n", 1, 0);
    }
    portENTER_CRITICAL(&s_lock);
    if (written && !error && atomic_load(&s_reserved)) {
        s_activity_ms = clock_ms();
        if (command->operation == QDD_DRIVER_READ && command->offset <= s_view.transferred_bytes &&
                command->length > s_view.transferred_bytes - command->offset) {
            // Count only the contiguous prefix of fully transmitted frames.
            // Duplicate/overlapping reads add no already-counted bytes, and a
            // request at the end cannot hide a hole at the beginning.
            s_view.transferred_bytes = command->offset + command->length;
            if (s_view.transferred_bytes == s_view.total_bytes) s_view.phase = QDD_DRIVER_USB_SENT;
        }
    }
    const uint32_t cancel_reply = s_cancel_reply;
    s_cancel_reply = 0;
    if (!cancel_reply) {
        // Seeing no cancellation and closing this job are one atomic action.
        // A CANCEL arriving after unlock is a new queued job, never a slot
        // silently left behind for the next INFO session.
        s_busy = false;
        if (!s_session[0]) clear_session_locked();
        portEXIT_CRITICAL(&s_lock);
        return;
    }
    // Close the old token before unlocking this cancellation branch. A second
    // late CANCEL cannot publish another old token while its OK is in flight.
    view_cancelled_locked();
    clear_session_locked();
    portEXIT_CRITICAL(&s_lock);
    length = qdd_driver_format_ok(s_frame, sizeof(s_frame), cancel_reply);
    (void)write_frame(s_frame, length, false);
    portENTER_CRITICAL(&s_lock);
    s_busy = false;
    if (!s_session[0]) clear_session_locked();
    portEXIT_CRITICAL(&s_lock);
}

static void worker_once(void) {
    expire_session();
    qdd_driver_command_t command = {0};
    bool pending;
    portENTER_CRITICAL(&s_lock);
    pending = s_pending;
    if (pending) { command = s_command; s_pending = false; }
    portEXIT_CRITICAL(&s_lock);
    if (pending) process_command(&command);
    // No other task calls the native USB writer after startup.
    size_t length = 0;
    portENTER_CRITICAL(&s_lock);
    if (s_reply_count) {
        length = s_reply_lengths[s_reply_head];
        memcpy(s_frame, s_replies[s_reply_head], length);
        s_reply_head = (s_reply_head + 1) % USB_REPLY_SLOTS;
        s_reply_count--;
    }
    portEXIT_CRITICAL(&s_lock);
    // Preserve the existing ordinary-control reply's 10 ms native TX budget.
    // Only read-only DATA frames use the longer, separately bounded writer.
    if (length && (!atomic_load(&s_online) ||
            usb_serial_jtag_write_bytes(s_frame, length, pdMS_TO_TICKS(10)) != (int)length)) {
        atomic_store(&s_reply_failed, true);
        fail_session(failure_reason(QDD_DRIVER_USB_ERROR_IO));
    }
}

static void usb_worker(void *context) {
    (void)context;
    for (;;) { worker_once(); vTaskDelay(pdMS_TO_TICKS(1)); }
}

esp_err_t qdd_driver_usb_start(void) {
    if (s_started) return ESP_OK;
    if (xTaskCreate(usb_worker, "qdd_usb_tx", 4096, NULL, 5, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    s_started = true;
    return ESP_OK;
}
