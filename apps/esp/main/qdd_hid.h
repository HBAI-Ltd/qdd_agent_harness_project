// QDD serial protocol and safety policy; independent of ESP-IDF and LVGL.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define QDD_LINE_MAX 128
#define QDD_HEARTBEAT_MS 1500
#define QDD_REPLY_MAX 256
#define QDD_REPORT_MOUSE 1
#define QDD_REPORT_KEYBOARD 2
#define QDD_REPORT_CONSUMER 3

typedef enum {
  QDD_PING, QDD_STATUS, QDD_ARM, QDD_PAUSE, QDD_RELEASE,
  QDD_MOVE, QDD_KEY, QDD_CONSUMER, QDD_PAIR, QDD_PAIR_STATUS
} qdd_op_t;

typedef struct {
  uint32_t id;
  qdd_op_t op;
  int32_t args[4];
} qdd_command_t;

typedef struct {
  char line[QDD_LINE_MAX + 1];
  size_t length;
  bool overflow;
  bool invalid;
} qdd_stream_t;

typedef struct {
  bool connected;
  bool encrypted;
  bool authenticated;
  bool bonded;
  bool armed;
  bool locked;
  bool ready;
  bool consumer_ready;
  bool heartbeat_seen;
  bool release_required;
  uint64_t last_ping_ms;
} qdd_hid_state_t;

typedef struct {
  uint8_t notify_masks[2];
  uint8_t protocol_mode;
} qdd_hid_subscriptions_t;

typedef bool (*qdd_report_fn)(uint8_t report_id, const uint8_t *data,
                              size_t length, void *context);
typedef void (*qdd_line_fn)(const char *line, const char *error, void *context);

void qdd_stream_feed(qdd_stream_t *stream, const uint8_t *bytes, size_t length,
                     qdd_line_fn on_line, void *context);
bool qdd_parse_command(const char *line, qdd_command_t *command);
void qdd_hid_set_link(qdd_hid_state_t *state, bool connected, bool encrypted,
                      bool authenticated, bool bonded);
void qdd_hid_set_ready(qdd_hid_state_t *state, bool ready, bool consumer_ready);
void qdd_hid_subscriptions_reset(qdd_hid_subscriptions_t *subscriptions);
void qdd_hid_subscriptions_set(qdd_hid_subscriptions_t *subscriptions,
                               uint8_t mode, uint8_t report_id, bool enabled);
bool qdd_hid_subscriptions_notifying(const qdd_hid_subscriptions_t *subscriptions,
                                     uint8_t report_id);
bool qdd_hid_subscriptions_ready(const qdd_hid_subscriptions_t *subscriptions);
bool qdd_hid_pnp_id(uint8_t out[7], uint8_t source, uint16_t vendor,
                    uint16_t product, uint16_t version);
void qdd_hid_pause(qdd_hid_state_t *state, bool physical_stop);
void qdd_hid_unlock(qdd_hid_state_t *state);
void qdd_hid_tick(qdd_hid_state_t *state, uint64_t now_ms, bool usb_connected);
bool qdd_hid_release(qdd_hid_state_t *state, qdd_report_fn report, void *context);
const char *qdd_hid_execute(qdd_hid_state_t *state, const qdd_command_t *command,
                            uint64_t now_ms, qdd_report_fn report, void *context);
void qdd_format_reply(char *buffer, size_t size, uint32_t id, const char *error,
                      const qdd_hid_state_t *state, const char *device_name);
void qdd_format_pairing_reply(char *buffer, size_t size, uint32_t id, const char *error,
                              const qdd_hid_state_t *state, const char *device_name,
                              bool pairing_open, bool passkey_visible, uint32_t passkey);
