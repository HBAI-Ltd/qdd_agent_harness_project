#include "qdd_hid.h"

#include <stdio.h>
#include <string.h>

void qdd_stream_feed(qdd_stream_t *stream, const uint8_t *bytes, size_t length,
                     qdd_line_fn on_line, void *context) {
  for (size_t i = 0; i < length; i++) {
    const uint8_t byte = bytes[i];
    if (byte == '\n') {
      if (stream->length && stream->line[stream->length - 1] == '\r') {
        stream->length--;
      }
      stream->line[stream->length] = '\0';
      if (stream->length || stream->overflow || stream->invalid) {
        on_line(stream->line, stream->overflow ? "LINE_TOO_LONG" :
                stream->invalid ? "BAD_COMMAND" : NULL, context);
      }
      stream->length = 0;
      stream->overflow = false;
      stream->invalid = false;
    } else if (stream->length < QDD_LINE_MAX) {
      if (byte < 32 && byte != '\r') stream->invalid = true;
      if (byte > 126) stream->invalid = true;
      stream->line[stream->length++] = (char)byte;
    } else {
      stream->overflow = true;
    }
  }
}

static bool number(const char *text, int32_t minimum, int32_t maximum, int32_t *out) {
  bool negative = false;
  if (*text == '-') {
    negative = true;
    text++;
  }
  if (!*text) return false;
  uint32_t value = 0;
  for (; *text; text++) {
    if (*text < '0' || *text > '9') return false;
    const uint32_t digit = (uint32_t)(*text - '0');
    if (value > (2147483647u - digit) / 10u) return false;
    value = value * 10u + digit;
  }
  const int32_t result = negative ? -(int32_t)value : (int32_t)value;
  if (result < minimum || result > maximum) return false;
  *out = result;
  return true;
}

bool qdd_parse_command(const char *line, qdd_command_t *command) {
  memset(command, 0, sizeof(*command));
  const size_t length = strlen(line);
  if (length > QDD_LINE_MAX) return false;
  char copy[QDD_LINE_MAX + 1];
  memcpy(copy, line, length + 1);
  char *tokens[8];
  size_t count = 0;
  char *cursor = copy;
  while (*cursor) {
    while (*cursor == ' ') cursor++;
    if (!*cursor) break;
    if (count == sizeof(tokens) / sizeof(tokens[0])) return false;
    tokens[count++] = cursor;
    while (*cursor && *cursor != ' ') cursor++;
    if (*cursor) *cursor++ = '\0';
  }
  if (count < 3 || strcmp(tokens[0], "QDDHID/1") != 0) return false;
  int32_t id;
  if (!number(tokens[1], 1, INT32_MAX, &id)) return false;
  command->id = (uint32_t)id;
  static const struct { const char *name; qdd_op_t op; size_t argc; } operations[] = {
    {"PING", QDD_PING, 0}, {"STATUS", QDD_STATUS, 0}, {"ARM", QDD_ARM, 0},
    {"PAUSE", QDD_PAUSE, 0}, {"RELEASE", QDD_RELEASE, 0}, {"MOVE", QDD_MOVE, 4},
    {"KEY", QDD_KEY, 2}, {"CONSUMER", QDD_CONSUMER, 1},
    {"PAIR", QDD_PAIR, 0}, {"PAIR_STATUS", QDD_PAIR_STATUS, 0}
  };
  for (size_t i = 0; i < sizeof(operations) / sizeof(operations[0]); i++) {
    if (strcmp(tokens[2], operations[i].name) != 0) continue;
    command->op = operations[i].op;
    if (count != 3 + operations[i].argc) return false;
    for (size_t arg = 0; arg < operations[i].argc; arg++) {
      const int32_t minimum = command->op == QDD_MOVE && arg < 3 ? -127 : 0;
      const int32_t maximum = command->op == QDD_MOVE ? (arg < 3 ? 127 : 7) :
                              command->op == QDD_CONSUMER ? 65535 : 255;
      if (!number(tokens[arg + 3], minimum, maximum, &command->args[arg])) return false;
    }
    return true;
  }
  return false;
}

void qdd_hid_set_link(qdd_hid_state_t *state, bool connected, bool encrypted,
                      bool authenticated, bool bonded) {
  if (state->connected != connected || state->encrypted != encrypted ||
      state->authenticated != authenticated || state->bonded != bonded) {
    state->armed = false;
    state->release_required = true;
    state->ready = false;
    state->consumer_ready = false;
  }
  state->connected = connected;
  state->encrypted = encrypted;
  state->authenticated = authenticated;
  state->bonded = bonded;
}

void qdd_hid_set_ready(qdd_hid_state_t *state, bool ready, bool consumer_ready) {
  if (state->ready != ready) {
    state->armed = false;
    state->release_required = true;
  }
  state->ready = ready;
  state->consumer_ready = consumer_ready;
}

void qdd_hid_subscriptions_reset(qdd_hid_subscriptions_t *subscriptions) {
  memset(subscriptions, 0, sizeof(*subscriptions));
  subscriptions->protocol_mode = 1;
}

void qdd_hid_subscriptions_set(qdd_hid_subscriptions_t *subscriptions,
                               uint8_t mode, uint8_t report_id, bool enabled) {
  if (mode > 1 || report_id < 1 || report_id > 3) return;
  const uint8_t bit = (uint8_t)(1u << report_id);
  if (enabled) subscriptions->notify_masks[mode] |= bit;
  else subscriptions->notify_masks[mode] &= (uint8_t)~bit;
}

bool qdd_hid_subscriptions_notifying(const qdd_hid_subscriptions_t *subscriptions,
                                     uint8_t report_id) {
  if (subscriptions->protocol_mode > 1 || report_id < 1 || report_id > 3) return false;
  if (subscriptions->protocol_mode == 0 && report_id == QDD_REPORT_CONSUMER) return false;
  return (subscriptions->notify_masks[subscriptions->protocol_mode] & (1u << report_id)) != 0;
}

bool qdd_hid_subscriptions_ready(const qdd_hid_subscriptions_t *subscriptions) {
  return qdd_hid_subscriptions_notifying(subscriptions, QDD_REPORT_MOUSE) &&
         qdd_hid_subscriptions_notifying(subscriptions, QDD_REPORT_KEYBOARD);
}

bool qdd_hid_pnp_id(uint8_t out[7], uint8_t source, uint16_t vendor,
                    uint16_t product, uint16_t version) {
  if (source != 1 && source != 2) return false;
  out[0] = source;
  out[1] = (uint8_t)vendor;
  out[2] = (uint8_t)(vendor >> 8);
  out[3] = (uint8_t)product;
  out[4] = (uint8_t)(product >> 8);
  out[5] = (uint8_t)version;
  out[6] = (uint8_t)(version >> 8);
  return true;
}

void qdd_hid_pause(qdd_hid_state_t *state, bool physical_stop) {
  state->armed = false;
  state->release_required = true;
  if (physical_stop) state->locked = true;
}

void qdd_hid_unlock(qdd_hid_state_t *state) {
  state->locked = false;
  state->armed = false;
  state->release_required = true;
}

static bool fresh(const qdd_hid_state_t *state, uint64_t now_ms) {
  return state->heartbeat_seen && now_ms >= state->last_ping_ms &&
         now_ms - state->last_ping_ms <= QDD_HEARTBEAT_MS;
}

void qdd_hid_tick(qdd_hid_state_t *state, uint64_t now_ms, bool usb_connected) {
  if (!usb_connected || !fresh(state, now_ms)) {
    if (state->armed) qdd_hid_pause(state, false);
    if (!usb_connected) state->heartbeat_seen = false;
  }
}

bool qdd_hid_release(qdd_hid_state_t *state, qdd_report_fn report, void *context) {
  if (!state->connected || !state->encrypted || !state->bonded) {
    state->release_required = false;
    return true;
  }
  const uint8_t zero[8] = {0};
  // Attempt every release even if a preceding report fails.
  const bool mouse = report(QDD_REPORT_MOUSE, zero, 4, context);
  const bool keyboard = report(QDD_REPORT_KEYBOARD, zero, 8, context);
  const bool consumer = report(QDD_REPORT_CONSUMER, zero, 2, context);
  state->release_required = !(mouse && keyboard && consumer);
  if (state->release_required) state->armed = false;
  return !state->release_required;
}

static const char *permission(const qdd_hid_state_t *state, uint64_t now_ms) {
  if (state->locked) return "LOCKED";
  if (!state->connected) return "NOT_CONNECTED";
  if (!state->encrypted || !state->bonded) {
    return "NOT_AUTHENTICATED";
  }
  if (!state->ready) return "HID_NOT_READY";
  if (!fresh(state, now_ms)) return "HEARTBEAT_EXPIRED";
  return NULL;
}

const char *qdd_hid_text_permission(const qdd_hid_state_t *state, uint64_t now_ms) {
  const char *error = permission(state, now_ms);
  return error ? error : !state->armed ? "NOT_ARMED" : NULL;
}

const char *qdd_hid_execute(qdd_hid_state_t *state, const qdd_command_t *command,
                            uint64_t now_ms, qdd_report_fn report, void *context) {
  switch (command->op) {
    case QDD_PING:
      state->last_ping_ms = now_ms;
      state->heartbeat_seen = true;
      return NULL;
    case QDD_STATUS:
    case QDD_PAIR_STATUS: return NULL;
    case QDD_PAIR:
    case QDD_PAUSE:
      qdd_hid_pause(state, false);
      return qdd_hid_release(state, report, context) ? NULL : "HID_SEND_FAILED";
    case QDD_RELEASE:
      return qdd_hid_release(state, report, context) ? NULL : "HID_SEND_FAILED";
    default: break;
  }
  const char *error = permission(state, now_ms);
  if (error) return error;
  if (command->op == QDD_ARM) {
    if (!qdd_hid_release(state, report, context)) return "HID_SEND_FAILED";
    state->armed = true;
    return NULL;
  }
  uint8_t data[8] = {0};
  uint8_t id;
  size_t length;
  if (command->op == QDD_MOVE) {
    id = QDD_REPORT_MOUSE;
    length = 4;
    data[0] = (uint8_t)command->args[3];
    data[1] = (uint8_t)command->args[0];
    data[2] = (uint8_t)command->args[1];
    data[3] = (uint8_t)command->args[2];
  } else if (command->op == QDD_KEY) {
    id = QDD_REPORT_KEYBOARD;
    length = 8;
    // KEY <any modifier> 0 always releases modifiers as well as the key.
    data[0] = command->args[1] ? (uint8_t)command->args[0] : 0;
    data[2] = (uint8_t)command->args[1];
  } else if (command->op == QDD_CONSUMER) {
    if (command->args[0] && !state->consumer_ready) return "HID_NOT_READY";
    id = QDD_REPORT_CONSUMER;
    length = 2;
    data[0] = (uint8_t)command->args[0];
    data[1] = (uint8_t)((uint32_t)command->args[0] >> 8);
  } else {
    return "BAD_COMMAND";
  }
  // A live, secure controller can operate immediately. PAUSE remains an
  // internal release/reset command, rather than a user-managed enable latch.
  // A new control round must first clear every previous held report.
  if (!state->armed) {
    if (!qdd_hid_release(state, report, context)) return "HID_SEND_FAILED";
    state->armed = true;
  }
  if (report(id, data, length, context)) return NULL;
  qdd_hid_pause(state, false);
  (void)qdd_hid_release(state, report, context);
  return "HID_SEND_FAILED";
}

void qdd_format_pairing_reply(char *buffer, size_t size, uint32_t id, const char *error,
                              const qdd_hid_state_t *state, const char *device_name,
                              bool pairing_open, bool passkey_visible, uint32_t passkey) {
  qdd_format_reply(buffer, size, id, error, state, device_name);
  if (error) return;
  const size_t length = strlen(buffer);
  if (length < 2 || buffer[length - 2] != '}') return;
  const bool visible = pairing_open && passkey_visible;
  const size_t offset = length - 2;
  if (visible) {
    (void)snprintf(buffer + offset, size - offset,
      ",\"pairingOpen\":true,\"passkeyVisible\":true,\"passkey\":%lu}\n",
      (unsigned long)passkey);
  } else {
    (void)snprintf(buffer + offset, size - offset,
      ",\"pairingOpen\":%s,\"passkeyVisible\":false}\n", pairing_open ? "true" : "false");
  }
}

void qdd_format_reply(char *buffer, size_t size, uint32_t id, const char *error,
                      const qdd_hid_state_t *state, const char *device_name) {
  if (error) {
    (void)snprintf(buffer, size, "QDDHID/1 %lu ERR %s\n", (unsigned long)id, error);
    return;
  }
  (void)snprintf(buffer, size,
    "QDDHID/1 %lu OK {\"v\":1,\"connected\":%s,\"encrypted\":%s,"
    "\"armed\":%s,\"locked\":%s,\"bonded\":%s,\"ready\":%s,\"name\":\"%s\"}\n",
    (unsigned long)id, state->connected ? "true" : "false",
    state->encrypted ? "true" : "false", state->armed ? "true" : "false",
    state->locked ? "true" : "false", state->bonded ? "true" : "false",
    state->ready ? "true" : "false", device_name);
}
