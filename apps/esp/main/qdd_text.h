#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define QDD_TEXT_MAX 512u
#define QDD_TEXT_DATA_MAX 24u
#define QDD_TEXT_FRAME_MAX 64u
#define QDD_TEXT_RESULT_MS 10000u

typedef enum { QDD_TEXT_BEGIN, QDD_TEXT_DATA, QDD_TEXT_COMMIT, QDD_TEXT_STATUS, QDD_TEXT_CANCEL } qdd_text_op_t;
typedef enum { QDD_TEXT_IDLE, QDD_TEXT_RECEIVING, QDD_TEXT_QUEUED, QDD_TEXT_SENDING,
    QDD_TEXT_AWAITING_ACK, QDD_TEXT_ACCEPTED, QDD_TEXT_REJECTED, QDD_TEXT_UNCERTAIN, QDD_TEXT_CANCELLED } qdd_text_status_t;
typedef struct {
    uint32_t request_id, editor_epoch;
    uint64_t id;
    uint16_t length, offset;
    uint8_t data[QDD_TEXT_DATA_MAX];
    qdd_text_op_t operation;
} qdd_text_command_t;
typedef struct {
    uint8_t text[QDD_TEXT_MAX];
    uint64_t id, high_id, queued_ms, cancel_id, flight_id;
    uint32_t editor_epoch, transfer_epoch, high_epoch, flight_token;
    uint16_t length, received, tx_offset, prepared_count, flight_count;
    uint8_t stage, prepared_kind, flight_kind;
    qdd_text_status_t status;
    bool ready, in_flight, commit_sent;
} qdd_text_t;

bool qdd_text_parse(const char *line, qdd_text_command_t *command);
bool qdd_text_utf8(const uint8_t *bytes, size_t length);
const char *qdd_text_execute(qdd_text_t *state, const qdd_text_command_t *command, uint64_t now_ms);
void qdd_text_editor(qdd_text_t *state, bool ready, uint32_t epoch);
// Clear sensitive bytes immediately. Queued/possibly delivered work is uncertain.
void qdd_text_abort(qdd_text_t *state, bool link_alive);
void qdd_text_tick(qdd_text_t *state, uint64_t now_ms);
size_t qdd_text_frame(qdd_text_t *state, uint16_t mtu, uint8_t *out, size_t capacity);
void qdd_text_indication_queued(qdd_text_t *state, uint32_t token);
void qdd_text_indication_done(qdd_text_t *state, uint32_t token, bool success);
void qdd_text_ack(qdd_text_t *state, uint64_t id, uint32_t epoch, uint8_t status);
void qdd_text_reply(char *out, size_t capacity, uint32_t request_id, const char *error,
    const qdd_text_t *state, bool current_editor);
