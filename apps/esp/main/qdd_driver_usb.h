#pragma once

#include "esp_err.h"
#include "qdd_driver_protocol.h"
#include <stdbool.h>
#include <stddef.h>

#define QDD_DRIVER_IDLE_MS 60000u
#define QDD_DRIVER_USB_REPLY_MAX 512u

typedef enum {
    QDD_DRIVER_USB_IDLE, QDD_DRIVER_USB_CHECKING, QDD_DRIVER_USB_TRANSFERRING,
    QDD_DRIVER_USB_SENT, QDD_DRIVER_USB_CANCELLED, QDD_DRIVER_USB_ERROR
} qdd_driver_usb_phase_t;

typedef enum {
    QDD_DRIVER_USB_ERROR_NONE, QDD_DRIVER_USB_ERROR_ASSET, QDD_DRIVER_USB_ERROR_IO,
    QDD_DRIVER_USB_ERROR_DISCONNECTED, QDD_DRIVER_USB_ERROR_EXPIRED,
    QDD_DRIVER_USB_ERROR_CLOCK, QDD_DRIVER_USB_ERROR_CONTROL
} qdd_driver_usb_error_t;

typedef struct {
    qdd_driver_usb_phase_t phase;
    qdd_driver_usb_error_t error;
    uint32_t total_bytes, transferred_bytes;
} qdd_driver_usb_view_t;

// Read-only coherent UI snapshot. SENT means ESP frame transmission completed;
// it never proves that the PC saved, verified, extracted, or installed the ZIP.
qdd_driver_usb_view_t qdd_driver_usb_view(void);

// Starts the sole USB TX worker after the native USB driver is installed.
// Main-loop calls never wait for Flash reads, hashing, or USB transmission.
esp_err_t qdd_driver_usb_start(void);
void qdd_driver_usb_tick(bool usb_connected, bool control_busy);
bool qdd_driver_usb_reserved(void);
void qdd_driver_usb_submit(const qdd_driver_command_t *command);
bool qdd_driver_usb_reply(const char *reply, size_t length);
// Preserves the original fail-closed controller release on a native short
// ordinary reply. The main safety loop consumes this numeric notification.
bool qdd_driver_usb_take_reply_failure(void);

