#include "qdd_text.h"
#include "qdd_hid.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void clear_text(const qdd_text_t *state) {
    for (size_t i = 0; i < sizeof(state->text); i++) assert(!state->text[i]);
    assert(!state->length && !state->received);
}
static void test_parser_and_utf8(void) {
    qdd_text_command_t command;
    assert(qdd_text_parse("QDDTXT/1 2147483647 BEGIN ffffffffffffffff 4294967295 512", &command));
    assert(command.id == UINT64_MAX && command.editor_epoch == UINT32_MAX && command.length == 512);
    assert(qdd_text_parse("QDDTXT/1 1 STATUS 0", &command) && !command.id);
    assert(qdd_text_parse("QDDTXT/1 1 STATUS 0000000000000000", &command) && !command.id); // Exact Rust preflight wire.
    assert(qdd_text_parse("QDDTXT/1 2 DATA 0000000000000001 0 e4b8ade69687", &command));
    assert(command.length == 6 && qdd_text_utf8(command.data, command.length));
    const char *bad[] = {"QDDTXT/1 0 STATUS 0", "QDDTXT/1 2147483648 STATUS 0", "QDDTXT/1 1 BEGIN 0000000000000000 1 1",
        "QDDTXT/1 1 BEGIN 0000000000000001 0 1", "QDDTXT/1 1 BEGIN 0000000000000001 1 0",
        "QDDTXT/1 1 BEGIN 0000000000000001 4294967296 1", "QDDTXT/1 1 BEGIN 0000000000000001 1 513",
        "QDDTXT/1 1 DATA 0000000000000001 0 e4b8ad0", "QDDTXT/1 1 DATA 0000000000000001 0 zz",
        "QDDTXT/1 1 DATA 0000000000000001 513 ff", "QDDTXT/1 1 STATUS 0 ",
        "QDDTXT/1 1 STATUS 0 extra", "QDDTXT/1 1  STATUS 0", "QDDTXT/1 1 COMMIT 0", "QDDTXT/1 1 CANCEL 1"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) assert(!qdd_text_parse(bad[i], &command));
    const uint8_t valid[] = {'A',0xe4,0xb8,0xad,0xf0,0x9f,0x98,0x80,'\n'};
    assert(qdd_text_utf8(valid, sizeof(valid)));
    const uint8_t bad_utf[][4] = {{0xc0,0x80}, {0xed,0xa0,0x80}, {0xf4,0x90,0x80,0x80}, {0xf5,0x80,0x80,0x80}, {0x80}, {0xe4,0xb8}, {0}};
    const size_t sizes[] = {2,3,4,4,1,2,1};
    for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) assert(!qdd_text_utf8(bad_utf[i], sizes[i]));
}
static qdd_text_t receiving(uint64_t id, unsigned bytes) {
    qdd_text_t state = {0}; qdd_text_editor(&state, true, 7);
    const qdd_text_command_t begin = {.operation = QDD_TEXT_BEGIN, .id = id, .editor_epoch = 7, .length = bytes};
    assert(!qdd_text_execute(&state, &begin, 100)); return state;
}
static void load_ascii(qdd_text_t *state) {
    for (unsigned offset = 0; offset < state->length;) {
        unsigned count = state->length - offset; if (count > 24) count = 24;
        qdd_text_command_t data = {.operation = QDD_TEXT_DATA, .id = state->id, .offset = offset, .length = count};
        memset(data.data, 'a', count); assert(!qdd_text_execute(state, &data, 100)); offset += count;
    }
}
static void test_receiving_offsets_commit_and_replay(void) {
    qdd_text_t state = receiving(1, 6);
    qdd_text_command_t cmd = {.operation = QDD_TEXT_COMMIT, .id = 1};
    assert(!strcmp(qdd_text_execute(&state, &cmd, 100), "INCOMPLETE"));
    cmd = (qdd_text_command_t){.operation = QDD_TEXT_DATA, .id = 1, .offset = 1, .length = 6, .data = {0xe4,0xb8,0xad,0xe6,0x96,0x87}};
    assert(!strcmp(qdd_text_execute(&state, &cmd, 100), "BAD_OFFSET"));
    cmd.offset = 0; assert(!qdd_text_execute(&state, &cmd, 100));
    assert(!qdd_text_execute(&state, &cmd, 100) && state.received == 6);
    cmd.data[0] ^= 1; assert(!strcmp(qdd_text_execute(&state, &cmd, 100), "BAD_OFFSET"));
    cmd = (qdd_text_command_t){.operation = QDD_TEXT_COMMIT, .id = 1};
    assert(!qdd_text_execute(&state, &cmd, 100) && state.status == QDD_TEXT_QUEUED);
    assert(!qdd_text_execute(&state, &cmd, 100));
    qdd_text_ack(&state, 1, 7, 0); assert(state.status == QDD_TEXT_QUEUED); // Early accepted cannot forge COMMIT.
    qdd_text_abort(&state, false); assert(state.status == QDD_TEXT_UNCERTAIN); clear_text(&state);
    qdd_text_editor(&state, true, 7);
    cmd = (qdd_text_command_t){.operation = QDD_TEXT_BEGIN, .id = 1, .editor_epoch = 7, .length = 6};
    assert(!strcmp(qdd_text_execute(&state, &cmd, 100), "STALE_TRANSFER"));
    cmd.id = 2; assert(!qdd_text_execute(&state, &cmd, 100));
    qdd_text_editor(&state, false, 8); assert(state.status == QDD_TEXT_REJECTED); clear_text(&state);
    qdd_text_editor(&state, true, 8); cmd.id = 1; cmd.editor_epoch = 8; assert(!qdd_text_execute(&state, &cmd, 100));
}
static void test_single_indication_mtu_and_terminal_ack(void) {
    qdd_text_t state = receiving(1, 512); load_ascii(&state);
    const qdd_text_command_t commit = {.operation = QDD_TEXT_COMMIT, .id = 1};
    assert(!qdd_text_execute(&state, &commit, 100));
    uint8_t frame[64], received[512]; unsigned frames = 0, data_bytes = 0;
    while (state.status != QDD_TEXT_AWAITING_ACK) {
        const size_t count = qdd_text_frame(&state, 23, frame, sizeof(frame));
        assert(count >= 10 && count <= 20 && frame[0] == 1);
        if (frame[1] == 1) assert(count == 16 && frame[2] == 1 && frame[10] == 7 && frame[14] == 0 && frame[15] == 2);
        if (frame[1] == 2) {
            assert((unsigned)(frame[10] | frame[11] << 8) == data_bytes);
            memcpy(received + data_bytes, frame + 12, count - 12); data_bytes += (unsigned)count - 12;
        }
        if (frame[1] == 3) assert(count == 14);
        qdd_text_indication_queued(&state, ++frames);
        assert(!qdd_text_frame(&state, 23, frame, sizeof(frame))); // Nothing queued before ATT confirmation.
        qdd_text_indication_done(&state, frames + 100, true); assert(state.in_flight); // Stale token ignored.
        qdd_text_indication_done(&state, frames, true);
    }
    assert(frames == 66 && data_bytes == 512 && !memcmp(received, state.text, 512));
    qdd_text_ack(&state, 1, 8, 0); assert(state.status == QDD_TEXT_AWAITING_ACK);
    qdd_text_ack(&state, 1, 7, 0); assert(state.status == QDD_TEXT_ACCEPTED); clear_text(&state);
    assert(!qdd_text_execute(&state, &commit, 100));
    assert(!qdd_text_frame(&state, 247, frame, sizeof(frame))); // Duplicate COMMIT never emits another frame.
    char reply[QDD_REPLY_MAX]; qdd_text_reply(reply, sizeof(reply), 2147483647u, NULL, &state, false);
    assert(strstr(reply, "\"status\":\"accepted\"") && strlen(reply) < sizeof(reply) - 1 && !strstr(reply, "aaa"));
    qdd_text_editor(&state, false, 9); assert(state.status == QDD_TEXT_ACCEPTED);
    qdd_text_reply(reply, sizeof(reply), 1, NULL, &state, false); assert(strstr(reply, "\"editorEpoch\":7"));
    qdd_text_reply(reply, sizeof(reply), 1, NULL, &state, true); assert(strstr(reply, "\"editorEpoch\":9"));
    assert(!qdd_text_execute(&state, &commit, 100)); // Duplicate COMMIT after focus loss is status only.
}
static void test_cancel_timeout_reject_utf8_and_capacity(void) {
    qdd_text_t state = receiving(9, 1); load_ascii(&state);
    qdd_text_command_t commit = {.operation = QDD_TEXT_COMMIT, .id = 9}; assert(!qdd_text_execute(&state, &commit, 100));
    uint8_t frame[66]; memset(frame, 0xcd, sizeof(frame));
    assert(!qdd_text_frame(&state, 23, frame + 1, 1) && frame[0] == 0xcd && frame[2] == 0xcd);
    assert(qdd_text_frame(&state, 247, frame, 64) == 16); qdd_text_indication_queued(&state, 1);
    qdd_text_editor(&state, false, 8); assert(state.status == QDD_TEXT_UNCERTAIN); clear_text(&state);
    qdd_text_indication_done(&state, 1, true);
    assert(qdd_text_frame(&state, 23, frame, 64) == 10 && frame[1] == 4);
    qdd_text_indication_queued(&state, 2); qdd_text_indication_done(&state, 2, true); assert(!state.cancel_id);
    state = receiving(9, 1); load_ascii(&state); assert(!qdd_text_execute(&state, &commit, 100));
    qdd_text_tick(&state, 10100); assert(state.status == QDD_TEXT_QUEUED);
    qdd_text_tick(&state, 10101); assert(state.status == QDD_TEXT_UNCERTAIN); clear_text(&state);
    state = receiving(9, 1); load_ascii(&state); assert(!qdd_text_execute(&state, &commit, 100));
    state.commit_sent = true; qdd_text_editor(&state, false, 8);
    assert(state.status == QDD_TEXT_UNCERTAIN); clear_text(&state);
    qdd_text_ack(&state, 9, 7, 0); assert(state.status == QDD_TEXT_ACCEPTED); clear_text(&state);
    state = receiving(9, 1); state.text[0] = 0; state.received = 1;
    assert(!strcmp(qdd_text_execute(&state, &commit, 100), "INVALID_UTF8") && state.status == QDD_TEXT_REJECTED); clear_text(&state);
    state = receiving(9, 1); load_ascii(&state); assert(!qdd_text_execute(&state, &commit, 100));
    qdd_text_ack(&state, 9, 7, 1); assert(state.status == QDD_TEXT_REJECTED); clear_text(&state);
}
int main(void) {
    test_parser_and_utf8(); test_receiving_offsets_commit_and_replay();
    test_single_indication_mtu_and_terminal_ack(); test_cancel_timeout_reject_utf8_and_capacity();
    puts("QDD text strict protocol, UTF8, monotone IDs, single indication, ACK and cancellation tests: PASS");
    return 0;
}
