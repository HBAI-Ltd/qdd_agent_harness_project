#pragma once

#include <stdbool.h>
#include <stdint.h>

// Pure lifecycle policy: local pairing pages hold their window; explicit
// protocol pairing outside those pages keeps its existing two-minute limit.
typedef struct {
  bool context_active;
  bool pairing_open;
  bool host_synced;
  bool advertise_pending;
  uint64_t pairing_deadline;
  uint64_t advertise_at;
} qdd_ble_policy_t;

static inline void qdd_ble_policy_open(qdd_ble_policy_t *policy, uint64_t now) {
  policy->pairing_open = true;
  policy->pairing_deadline = now + 120000u;
}

static inline void qdd_ble_policy_context(qdd_ble_policy_t *policy, bool active,
                                           bool secure, uint64_t now) {
  if (policy->context_active && !active) policy->pairing_open = false;
  policy->context_active = active;
  if (active && !secure && !policy->pairing_open) qdd_ble_policy_open(policy, now);
}

static inline void qdd_ble_policy_secure(qdd_ble_policy_t *policy) {
  policy->pairing_open = false;
}

static inline bool qdd_ble_policy_expire(qdd_ble_policy_t *policy, uint64_t now) {
  if (!policy->pairing_open || policy->context_active || now < policy->pairing_deadline) return false;
  policy->pairing_open = false;
  return true;
}

static inline void qdd_ble_policy_advertise(qdd_ble_policy_t *policy, uint64_t now) {
  if (!policy->advertise_pending && policy->advertise_at < now) policy->advertise_at = now;
  policy->advertise_pending = true;
}

static inline bool qdd_ble_policy_advertise_due(qdd_ble_policy_t *policy,
                                                 bool connected, bool active, uint64_t now) {
  if (!policy->host_synced || !policy->advertise_pending || connected || now < policy->advertise_at) return false;
  if (active) { policy->advertise_pending = false; return false; }
  policy->advertise_pending = false;
  policy->advertise_at = now + 250u;
  return true;
}

static inline void qdd_ble_policy_advertise_failed(qdd_ble_policy_t *policy) {
  policy->advertise_pending = true;
}
