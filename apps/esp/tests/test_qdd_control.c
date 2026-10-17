#include "qdd_control.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void denied(const char *actual, const char *expected) {
    assert(actual && strcmp(actual, expected) == 0);
}

static void usb_presence_tests(void) {
    qdd_usb_presence_t presence = {0};
    assert(!qdd_control_usb_live(&presence, false, 0));
    assert(!qdd_control_usb_live(&presence, false, 100)); // No startup grace without a connection.
    assert(qdd_control_usb_live(&presence, true, 100));
    assert(qdd_control_usb_live(&presence, false, 101));
    assert(qdd_control_usb_live(&presence, false, 149));
    assert(!qdd_control_usb_live(&presence, false, 150)); // Sustained loss is bounded at 50 ms.
    assert(!qdd_control_usb_live(&presence, false, 200));
    assert(qdd_control_usb_live(&presence, true, 201)); // Recovery never needs a long delay.
    assert(qdd_control_usb_live(&presence, false, 249));
    assert(!qdd_control_usb_live(&presence, false, 248)); // Regression while raw=false fails closed too.
    assert(!qdd_control_usb_live(&presence, false, 249));
    assert(qdd_control_usb_live(&presence, true, 250));
    assert(!qdd_control_usb_live(&presence, true, 249)); // Raw=true cannot hide a clock anomaly.
    assert(qdd_control_usb_live(&presence, true, 250));

    qdd_control_t control = {0};
    memset(&presence, 0, sizeof(presence));
    assert(!qdd_control_allow(&control, QDD_SOURCE_USB, QDD_PING, 1000));
    for (uint64_t now = 1000; now < 1400; now += 20) {
        // Intermittent SOF misses must not discard an otherwise fresh USB lease.
        assert(qdd_control_usb_live(&presence, true, now));
        assert(!qdd_control_tick(&control, qdd_control_usb_live(&presence, false, now + 19), false, now + 19));
        assert(control.owner == QDD_SOURCE_USB);
    }
    assert(!qdd_control_tick(&control, qdd_control_usb_live(&presence, false, 1429), false, 1429));
    assert(qdd_control_tick(&control, qdd_control_usb_live(&presence, false, 1430), false, 1430));
    assert(control.owner == QDD_SOURCE_NONE);
    assert(qdd_control_usb_live(&presence, true, 1431));
    denied(qdd_control_allow(&control, QDD_SOURCE_USB, QDD_MOVE, 1431), "HEARTBEAT_EXPIRED");
    // Debouncing only preserves presence; it cannot restore a dropped control lease.
    assert(!qdd_control_allow(&control, QDD_SOURCE_USB, QDD_PING, 1431));
    assert(!qdd_control_tick(&control, qdd_control_usb_live(&presence, true, 2931), false, 2931));
    assert(qdd_control_tick(&control, qdd_control_usb_live(&presence, true, 2932), false, 2932));
    assert(control.owner == QDD_SOURCE_NONE); // Raw presence never extends the 1500 ms PING lease.
}

int main(void) {
    usb_presence_tests();
    qdd_control_t control = {0};
    assert(!qdd_control_allow(&control, QDD_SOURCE_TCP, QDD_PING, 10));
    assert(control.owner == QDD_SOURCE_TCP);
    for (qdd_op_t op = QDD_PING; op <= QDD_CONSUMER; op++) {
        if (op == QDD_STATUS) assert(!qdd_control_allow(&control, QDD_SOURCE_USB, op, 20));
        else denied(qdd_control_allow(&control, QDD_SOURCE_USB, op, 20), "CONTROL_BUSY");
        assert(control.owner == QDD_SOURCE_TCP && control.last_ping_ms == 10);
    }
    denied(qdd_control_allow(&control, QDD_SOURCE_USB, QDD_PAIR, 20), "CONTROL_BUSY");
    denied(qdd_control_allow(&control, QDD_SOURCE_TCP, QDD_PAIR, 20), "USB_ONLY");
    denied(qdd_control_allow(&control, QDD_SOURCE_TCP, QDD_PAIR_STATUS, 20), "USB_ONLY");
    assert(!qdd_control_usb_config(&control, false));
    assert(!qdd_control_tick(&control, false, true, 1510));
    assert(qdd_control_tick(&control, true, true, 1511));
    assert(control.owner == QDD_SOURCE_NONE);
    denied(qdd_control_allow(&control, QDD_SOURCE_TCP, QDD_ARM, 1511), "HEARTBEAT_EXPIRED");
    assert(!qdd_control_allow(&control, QDD_SOURCE_USB, QDD_PING, 1512));
    assert(qdd_control_usb_config(&control, false));
    assert(!qdd_control_usb_config(&control, true));
    assert(!qdd_control_tick(&control, true, false, 1512)); // Other link cannot stop owner.
    assert(qdd_control_tick(&control, false, true, 1512));
    assert(!qdd_control_allow(&control, QDD_SOURCE_TCP, QDD_PING, 2000));
    assert(qdd_control_tick(&control, true, true, 1999)); // Clock anomaly.
    assert(!qdd_control_allow(&control, QDD_SOURCE_TCP, QDD_PING, 3000));
    assert(!qdd_control_drop(&control, QDD_SOURCE_USB));
    assert(qdd_control_drop(&control, QDD_SOURCE_TCP)); // TCP epoch must explicitly invalidate ownership.
    assert(control.owner == QDD_SOURCE_NONE);
    for (unsigned first = 0; first < 256; first++) {
        assert(qdd_private_ipv4(first << 24) == (first == 10 || first == 127));
    }
    assert(qdd_private_ipv4(0xC0A80101));
    assert(qdd_private_ipv4(0xAC100001) && qdd_private_ipv4(0xAC1F0001));
    assert(!qdd_private_ipv4(0xAC0F0001) && !qdd_private_ipv4(0xAC200001));
    assert(!qdd_private_ipv4(0xA9FE0001) && !qdd_private_ipv4(0x08080808));
    puts("QDD sole-controller source isolation, lease, epoch and private IPv4 tests: PASS");
}
