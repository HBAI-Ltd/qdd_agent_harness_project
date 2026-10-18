#include "qdd_text.h"
#include "qdd_hid.h"
#include <stdio.h>
#include <string.h>

static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}
static bool decimal(const char *text, uint32_t limit, uint32_t *value) {
    if (!*text) return false;
    *value = 0;
    for (; *text; text++) {
        if (*text < '0' || *text > '9') return false;
        const unsigned digit = (unsigned)(*text - '0');
        if (*value > (limit - digit) / 10u || digit > limit) return false;
        *value = *value * 10u + digit;
    }
    return true;
}
static bool transfer_id(const char *text, bool zero, uint64_t *id) {
    *id = 0;
    if (zero && !strcmp(text, "0")) return true;
    if (strlen(text) != 16) return false;
    for (unsigned i = 0; i < 16; i++) {
        const int value = hex_digit(text[i]); if (value < 0) return false;
        *id = (*id << 4) | (unsigned)value;
    }
    return zero || *id != 0;
}
bool qdd_text_parse(const char *line, qdd_text_command_t *command) {
    if (!line || !command) return false;
    memset(command, 0, sizeof(*command));
    const size_t length = strlen(line);
    if (length > QDD_LINE_MAX || strncmp(line, "QDDTXT/1 ", 9)) return false;
    char copy[QDD_LINE_MAX + 1]; memcpy(copy, line + 9, length - 9 + 1);
    char *tokens[5]; unsigned count = 0; char *cursor = copy;
    while (*cursor && count < 5) {
        if (*cursor == ' ') return false;
        tokens[count++] = cursor;
        while (*cursor && *cursor != ' ') cursor++;
        if (*cursor) { *cursor++ = 0; if (!*cursor) return false; }
    }
    if (*cursor || count < 3 || !decimal(tokens[0], 2147483647u, &command->request_id) || !command->request_id) return false;
    if (!strcmp(tokens[1], "BEGIN")) command->operation = QDD_TEXT_BEGIN;
    else if (!strcmp(tokens[1], "DATA")) command->operation = QDD_TEXT_DATA;
    else if (!strcmp(tokens[1], "COMMIT")) command->operation = QDD_TEXT_COMMIT;
    else if (!strcmp(tokens[1], "STATUS")) command->operation = QDD_TEXT_STATUS;
    else if (!strcmp(tokens[1], "CANCEL")) command->operation = QDD_TEXT_CANCEL;
    else return false;
    if (!transfer_id(tokens[2], command->operation == QDD_TEXT_STATUS, &command->id)) return false;
    if (command->operation == QDD_TEXT_BEGIN) {
        uint32_t bytes;
        if (count != 5 || !decimal(tokens[3], UINT32_MAX, &command->editor_epoch) || !command->editor_epoch ||
            !decimal(tokens[4], QDD_TEXT_MAX, &bytes) || !bytes) return false;
        command->length = (uint16_t)bytes; return true;
    }
    if (command->operation == QDD_TEXT_DATA) {
        uint32_t offset;
        if (count != 5 || !decimal(tokens[3], QDD_TEXT_MAX, &offset)) return false;
        const size_t digits = strlen(tokens[4]);
        if (!digits || digits % 2 || digits > QDD_TEXT_DATA_MAX * 2) return false;
        command->offset = (uint16_t)offset; command->length = (uint16_t)(digits / 2);
        for (unsigned i = 0; i < command->length; i++) {
            const int a = hex_digit(tokens[4][i * 2]), b = hex_digit(tokens[4][i * 2 + 1]);
            if (a < 0 || b < 0) return false;
            command->data[i] = (uint8_t)((a << 4) | b);
        }
        return true;
    }
    return count == 3;
}
bool qdd_text_utf8(const uint8_t *bytes, size_t length) {
    if (!bytes || !length || length > QDD_TEXT_MAX) return false;
    for (size_t i = 0; i < length;) {
        const uint8_t first = bytes[i++];
        if (first < 0x80) { if (!first) return false; continue; }
        unsigned following; uint32_t value, minimum;
        if (first >= 0xc2 && first <= 0xdf) { following = 1; value = first & 31u; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { following = 2; value = first & 15u; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { following = 3; value = first & 7u; minimum = 0x10000; }
        else return false;
        if (following > length - i) return false;
        while (following--) {
            const uint8_t next = bytes[i++]; if ((next & 0xc0) != 0x80) return false;
            value = (value << 6) | (next & 63u);
        }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    }
    return true;
}
static bool active(const qdd_text_t *state) {
    return state->status >= QDD_TEXT_RECEIVING && state->status <= QDD_TEXT_AWAITING_ACK;
}
static void terminal(qdd_text_t *state, qdd_text_status_t status) {
    memset(state->text, 0, sizeof(state->text));
    state->length = state->received = state->tx_offset = 0;
    state->status = status;
}
void qdd_text_abort(qdd_text_t *state, bool link_alive) {
    if (active(state)) {
        const bool queued = state->status >= QDD_TEXT_QUEUED;
        if (link_alive && queued) state->cancel_id = state->id;
        terminal(state, queued ? QDD_TEXT_UNCERTAIN : QDD_TEXT_CANCELLED);
    }
    if (!link_alive) {
        state->ready = false; state->editor_epoch = 0;
        state->in_flight = false; state->flight_token = 0; state->cancel_id = 0;
    }
}
void qdd_text_editor(qdd_text_t *state, bool ready, uint32_t epoch) {
    if (!ready || !epoch || state->editor_epoch != epoch) {
        const bool receiving = state->status == QDD_TEXT_RECEIVING;
        qdd_text_abort(state, true);
        if (receiving) state->status = QDD_TEXT_REJECTED;
    }
    state->ready = ready && epoch != 0;
    state->editor_epoch = epoch;
}
const char *qdd_text_execute(qdd_text_t *state, const qdd_text_command_t *command, uint64_t now_ms) {
    if (command->operation == QDD_TEXT_STATUS) return !command->id || command->id == state->id ? NULL : "STALE_TRANSFER";
    if (command->operation == QDD_TEXT_CANCEL) {
        if (command->id != state->id) return "TRANSFER_MISMATCH";
        qdd_text_abort(state, true); return NULL;
    }
    if (command->operation == QDD_TEXT_COMMIT && command->id == state->id && state->status >= QDD_TEXT_QUEUED) return NULL;
    if (!state->ready) return "NOT_READY";
    if (command->operation == QDD_TEXT_BEGIN) {
        if (!command->id || !command->editor_epoch || !command->length || command->length > QDD_TEXT_MAX) return "BAD_COMMAND";
        if (command->editor_epoch != state->editor_epoch) return "NOT_READY";
        if (active(state) || state->in_flight || state->cancel_id) {
            if (state->status == QDD_TEXT_RECEIVING && command->id == state->id &&
                command->editor_epoch == state->transfer_epoch && command->length == state->length) return NULL;
            return "TRANSFER_BUSY";
        }
        if (state->high_epoch == command->editor_epoch && command->id <= state->high_id) return "STALE_TRANSFER";
        state->id = state->high_id = command->id;
        state->transfer_epoch = state->high_epoch = command->editor_epoch;
        state->length = command->length; state->received = state->tx_offset = 0;
        state->stage = 1; state->prepared_kind = 0; state->commit_sent = false;
        memset(state->text, 0, sizeof(state->text)); state->status = QDD_TEXT_RECEIVING;
        return NULL;
    }
    if (command->id != state->id) return "TRANSFER_MISMATCH";
    if (command->operation == QDD_TEXT_COMMIT && state->status >= QDD_TEXT_QUEUED) return NULL;
    if (state->status != QDD_TEXT_RECEIVING) return "TRANSFER_BUSY";
    if (command->operation == QDD_TEXT_DATA) {
        if (!command->length || command->length > QDD_TEXT_DATA_MAX) return "BAD_COMMAND";
        if (command->offset < state->received) {
            return command->length <= state->received - command->offset &&
                !memcmp(state->text + command->offset, command->data, command->length) ? NULL : "BAD_OFFSET";
        }
        if (command->offset != state->received || command->length > state->length - state->received) return "BAD_OFFSET";
        memcpy(state->text + state->received, command->data, command->length);
        state->received += command->length; return NULL;
    }
    if (command->operation != QDD_TEXT_COMMIT) return "BAD_COMMAND";
    if (state->received != state->length) return "INCOMPLETE";
    if (!qdd_text_utf8(state->text, state->length)) { terminal(state, QDD_TEXT_REJECTED); return "INVALID_UTF8"; }
    state->status = QDD_TEXT_QUEUED; state->queued_ms = now_ms; return NULL;
}
void qdd_text_tick(qdd_text_t *state, uint64_t now_ms) {
    if (state->status >= QDD_TEXT_QUEUED && state->status <= QDD_TEXT_AWAITING_ACK &&
        (now_ms < state->queued_ms || now_ms - state->queued_ms > QDD_TEXT_RESULT_MS)) qdd_text_abort(state, true);
}
static void little(uint8_t *out, uint64_t value, unsigned bytes) {
    for (unsigned i = 0; i < bytes; i++) out[i] = (uint8_t)(value >> (i * 8));
}
size_t qdd_text_frame(qdd_text_t *state, uint16_t mtu, uint8_t *out, size_t capacity) {
    if (!out || state->in_flight || mtu < 23) return 0;
    const size_t bound = capacity < (size_t)mtu - 3 ? capacity : (size_t)mtu - 3;
    if (state->cancel_id) {
        if (bound < 10) return 0;
        out[0] = 1; out[1] = 4; little(out + 2, state->cancel_id, 8);
        state->prepared_kind = 4; state->prepared_count = 0; return 10;
    }
    if (state->status != QDD_TEXT_QUEUED && state->status != QDD_TEXT_SENDING) return 0;
    if (!state->ready || state->editor_epoch != state->transfer_epoch) { qdd_text_abort(state, true); return 0; }
    if ((state->stage == 1 && bound < 16) || (state->stage == 2 && bound <= 12) ||
        (state->stage == 3 && bound < 14)) return 0;
    out[0] = 1; out[1] = state->stage; little(out + 2, state->id, 8);
    state->prepared_kind = state->stage; state->prepared_count = 0;
    if (state->stage == 1) {
        if (bound < 16) return 0;
        little(out + 10, state->transfer_epoch, 4); little(out + 14, state->length, 2); return 16;
    }
    if (state->stage == 2) {
        if (bound <= 12) return 0;
        size_t portion = state->length - state->tx_offset;
        if (portion > bound - 12) portion = bound - 12;
        if (portion > QDD_TEXT_FRAME_MAX - 12) portion = QDD_TEXT_FRAME_MAX - 12;
        little(out + 10, state->tx_offset, 2); memcpy(out + 12, state->text + state->tx_offset, portion);
        state->prepared_count = (uint16_t)portion; return 12 + portion;
    }
    if (state->stage == 3 && bound >= 14) { little(out + 10, state->transfer_epoch, 4); return 14; }
    return 0;
}
void qdd_text_indication_queued(qdd_text_t *state, uint32_t token) {
    if (!token || state->in_flight || !state->prepared_kind) return;
    state->in_flight = true; state->flight_token = token;
    state->flight_kind = state->prepared_kind; state->flight_count = state->prepared_count;
    state->flight_id = state->prepared_kind == 4 ? state->cancel_id : state->id;
    if (state->prepared_kind != 4) state->status = QDD_TEXT_SENDING;
    if (state->prepared_kind == 3) state->commit_sent = true;
    state->prepared_kind = 0;
}
void qdd_text_indication_done(qdd_text_t *state, uint32_t token, bool success) {
    if (!state->in_flight || state->flight_token != token) return;
    state->in_flight = false; state->flight_token = 0;
    if (state->flight_kind == 4) { if (state->cancel_id == state->flight_id) state->cancel_id = 0; return; }
    if (!active(state)) return;
    if (!success) { qdd_text_abort(state, true); return; }
    if (state->flight_kind == 1) state->stage = 2;
    else if (state->flight_kind == 2) {
        state->tx_offset += state->flight_count;
        if (state->tx_offset == state->length) state->stage = 3;
    } else if (state->flight_kind == 3) state->status = QDD_TEXT_AWAITING_ACK;
}
void qdd_text_ack(qdd_text_t *state, uint64_t id, uint32_t epoch, uint8_t status) {
    if ((!active(state) && !(state->status == QDD_TEXT_UNCERTAIN && state->commit_sent)) ||
        id != state->id || epoch != state->transfer_epoch || status > 2 ||
        (status == 0 && !state->commit_sent)) return;
    terminal(state, status == 0 ? QDD_TEXT_ACCEPTED : status == 1 ? QDD_TEXT_REJECTED : QDD_TEXT_UNCERTAIN);
}
void qdd_text_reply(char *out, size_t capacity, uint32_t request_id, const char *error,
    const qdd_text_t *state, bool current_editor) {
    if (error) { (void)snprintf(out, capacity, "QDDTXT/1 %lu ERR %s\n", (unsigned long)request_id, error); return; }
    static const char *const names[] = {"idle", "receiving", "queued", "sending", "awaiting_ack", "accepted", "rejected", "uncertain", "cancelled"};
    char id[17]; static const char hex[] = "0123456789abcdef";
    for (unsigned i = 0; i < 16; i++) id[i] = hex[(state->id >> ((15 - i) * 4)) & 15u];
    id[16] = 0;
    (void)snprintf(out, capacity,
        "QDDTXT/1 %lu OK {\"id\":\"%s\",\"status\":\"%s\",\"editorEpoch\":%lu,\"ready\":%s,\"received\":%u,\"bytes\":%u}\n",
        (unsigned long)request_id, id, names[state->status],
        (unsigned long)(current_editor ? state->editor_epoch : state->transfer_epoch),
        state->ready ? "true" : "false", (unsigned)state->received, (unsigned)state->length);
}
