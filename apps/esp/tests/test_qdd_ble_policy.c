#include "qdd_ble_policy.h"

#include <assert.h>
#include <stdio.h>

static void test_manual_window(void) {
    qdd_ble_policy_t policy = {0};
    qdd_ble_policy_open(&policy, 1000);
    assert(policy.pairing_open);
    assert(policy.pairing_deadline == 121000);
    // An unchanged inactive guide must not cancel a deliberate pairing request.
    qdd_ble_policy_context(&policy, false, false, 1001);
    assert(policy.pairing_open);
    assert(!qdd_ble_policy_expire(&policy, 120999));
    assert(policy.pairing_open);
    assert(qdd_ble_policy_expire(&policy, 121000));
    assert(!policy.pairing_open);
    assert(!qdd_ble_policy_expire(&policy, 121001));
}

static void test_guide_window_and_security(void) {
    qdd_ble_policy_t policy = {0};
    qdd_ble_policy_context(&policy, true, false, 100);
    assert(policy.context_active && policy.pairing_open);
    // Waiting on the Bluetooth guide outlives the manual two-minute window.
    assert(!qdd_ble_policy_expire(&policy, 120100));
    assert(!qdd_ble_policy_expire(&policy, 600000));
    assert(policy.pairing_open);
    qdd_ble_policy_context(&policy, true, false, 600001);
    assert(policy.pairing_open);

    qdd_ble_policy_secure(&policy);
    assert(!policy.pairing_open);
    qdd_ble_policy_context(&policy, true, true, 600002);
    assert(!policy.pairing_open);
    qdd_ble_policy_context(&policy, false, true, 600003);
    assert(!policy.context_active && !policy.pairing_open);
}

static void test_leaving_guide_closes_only_guide_window(void) {
    qdd_ble_policy_t policy = {0};
    qdd_ble_policy_context(&policy, true, false, 1000);
    assert(policy.pairing_open);
    qdd_ble_policy_context(&policy, false, false, 1001);
    assert(!policy.context_active && !policy.pairing_open);
    qdd_ble_policy_context(&policy, false, false, 1002);
    assert(!policy.pairing_open);
    qdd_ble_policy_open(&policy, 2000);
    qdd_ble_policy_context(&policy, false, false, 2001);
    assert(policy.pairing_open);
    qdd_ble_policy_context(&policy, true, false, 2002);
    qdd_ble_policy_context(&policy, false, false, 2003);
    assert(!policy.pairing_open);
}

static void test_advertising_retry_and_gates(void) {
    qdd_ble_policy_t policy = {0};
    qdd_ble_policy_advertise(&policy, 1000);
    assert(policy.advertise_pending);
    assert(!qdd_ble_policy_advertise_due(&policy, false, false, 1000));
    assert(policy.advertise_pending); // The host has not synchronized yet.
    policy.host_synced = true;
    assert(!qdd_ble_policy_advertise_due(&policy, true, false, 1000));
    assert(policy.advertise_pending);
    assert(!qdd_ble_policy_advertise_due(&policy, false, true, 1000));
    assert(!policy.advertise_pending); // Active advertising needs no retry work.
    assert(!qdd_ble_policy_advertise_due(&policy, false, false, 1000));
    qdd_ble_policy_advertise(&policy, 1000);
    assert(qdd_ble_policy_advertise_due(&policy, false, false, 1000));
    assert(!policy.advertise_pending && policy.advertise_at == 1250);
    assert(!qdd_ble_policy_advertise_due(&policy, false, false, 1250));

    qdd_ble_policy_advertise_failed(&policy);
    assert(policy.advertise_pending);
    assert(!qdd_ble_policy_advertise_due(&policy, false, false, 1249));
    // Repeated GAP callbacks must not erase a failed attempt's future backoff.
    qdd_ble_policy_advertise(&policy, 1100);
    qdd_ble_policy_advertise(&policy, 1200);
    assert(policy.advertise_at == 1250);
    assert(!qdd_ble_policy_advertise_due(&policy, false, false, 1249));
    assert(qdd_ble_policy_advertise_due(&policy, false, false, 1250));
    assert(policy.advertise_at == 1500 && !policy.advertise_pending);

    for (uint64_t now = 1500; now <= 2500; now += 250) {
        qdd_ble_policy_advertise_failed(&policy);
        assert(!qdd_ble_policy_advertise_due(&policy, false, false, now - 1));
        assert(qdd_ble_policy_advertise_due(&policy, false, false, now));
        assert(policy.advertise_at == now + 250);
    }
}

int main(void) {
    test_manual_window();
    test_guide_window_and_security();
    test_leaving_guide_closes_only_guide_window();
    test_advertising_retry_and_gates();
    puts("BLE pairing guide, manual expiry and deferred advertising policy tests: PASS");
    return 0;
}
