#include "qdd_control.h"

bool qdd_control_usb_live(qdd_usb_presence_t *presence, bool raw_connected, uint64_t now_ms) {
    if (now_ms < presence->last_sample_ms) {
        presence->seen_connected = false;
        presence->last_connected_ms = 0;
        presence->last_sample_ms = now_ms;
        return false;
    }
    presence->last_sample_ms = now_ms;
    if (raw_connected) {
        presence->seen_connected = true;
        presence->last_connected_ms = now_ms;
        return true;
    }
    return presence->seen_connected && now_ms - presence->last_connected_ms < QDD_USB_LOSS_CONFIRM_MS;
}

bool qdd_control_drop(qdd_control_t *control, qdd_source_t source) {
    if (control->owner != source || source == QDD_SOURCE_NONE) return false;
    control->owner = QDD_SOURCE_NONE;
    control->last_ping_ms = 0;
    return true;
}

bool qdd_control_tick(qdd_control_t *control, bool usb_live, bool tcp_live, uint64_t now_ms) {
    const bool live = control->owner == QDD_SOURCE_USB ? usb_live :
        control->owner == QDD_SOURCE_TCP ? tcp_live : true;
    if (control->owner != QDD_SOURCE_NONE && (!live || now_ms < control->last_ping_ms ||
        now_ms - control->last_ping_ms > QDD_HEARTBEAT_MS)) {
        return qdd_control_drop(control, control->owner);
    }
    return false;
}

const char *qdd_control_allow(qdd_control_t *control, qdd_source_t source,
                            qdd_op_t operation, uint64_t now_ms) {
    if (source == QDD_SOURCE_NONE) return "BAD_COMMAND";
    if (source == QDD_SOURCE_TCP && (operation == QDD_PAIR || operation == QDD_PAIR_STATUS)) return "USB_ONLY";
    if (operation == QDD_STATUS || operation == QDD_PAIR_STATUS) return NULL;
    if (control->owner != QDD_SOURCE_NONE && control->owner != source) return "CONTROL_BUSY";
    if (operation == QDD_PING) {
        control->owner = source;
        control->last_ping_ms = now_ms;
        return NULL;
    }
    if (control->owner == QDD_SOURCE_NONE && operation != QDD_PAIR &&
        operation != QDD_PAUSE && operation != QDD_RELEASE) return "HEARTBEAT_EXPIRED";
    return NULL;
}

bool qdd_control_usb_config(const qdd_control_t *control, bool armed) {
    return control->owner != QDD_SOURCE_TCP && !armed;
}

bool qdd_private_ipv4(uint32_t address) {
    const uint32_t first = address >> 24, second = (address >> 16) & 255;
    return first == 10 || first == 127 || (first == 172 && second >= 16 && second <= 31) ||
        (first == 192 && second == 168);
}
