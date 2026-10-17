#pragma once
#include "qdd_hid.h"

typedef enum { QDD_SOURCE_NONE, QDD_SOURCE_USB, QDD_SOURCE_TCP } qdd_source_t;
typedef struct { qdd_source_t owner; uint64_t last_ping_ms; } qdd_control_t;

#define QDD_USB_LOSS_CONFIRM_MS 50u
typedef struct {
    uint64_t last_connected_ms;
    uint64_t last_sample_ms;
    bool seen_connected;
} qdd_usb_presence_t;

// USB SOF detection can flicker for a few milliseconds. Sustained loss still
// drops ownership; the separate PING lease and physical stop remain unchanged.
bool qdd_control_usb_live(qdd_usb_presence_t *presence, bool raw_connected, uint64_t now_ms);

bool qdd_control_tick(qdd_control_t *control, bool usb_live, bool tcp_live, uint64_t now_ms);
const char *qdd_control_allow(qdd_control_t *control, qdd_source_t source,
                            qdd_op_t operation, uint64_t now_ms);
bool qdd_control_drop(qdd_control_t *control, qdd_source_t source);
bool qdd_control_usb_config(const qdd_control_t *control, bool armed);
bool qdd_private_ipv4(uint32_t host_order_address);
