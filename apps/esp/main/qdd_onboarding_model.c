#include "qdd_onboarding_model.h"

#include <string.h>

typedef struct { const char *cursor; const char *end; } parser_t;

static void space(parser_t *parser) {
    while (parser->cursor < parser->end && (*parser->cursor == ' ' ||
        *parser->cursor == '\r' || *parser->cursor == '\n' || *parser->cursor == '\t')) {
        parser->cursor++;
    }
}

static bool take(parser_t *parser, char character) {
    space(parser);
    if (parser->cursor == parser->end || *parser->cursor != character) return false;
    parser->cursor++;
    return true;
}

static bool string(parser_t *parser, char *result, size_t capacity) {
    if (!take(parser, '"')) return false;
    size_t size = 0;
    while (parser->cursor < parser->end && *parser->cursor != '"') {
        const unsigned char character = (unsigned char)*parser->cursor++;
        // Registration strings contain only ASCII keys and UUIDs. Escapes and
        // control bytes are deliberately unsupported instead of partially decoded.
        if (character < 32 || character > 126 || character == '\\' || size + 1 >= capacity) return false;
        result[size++] = (char)character;
    }
    if (parser->cursor == parser->end) return false;
    parser->cursor++;
    result[size] = 0;
    return true;
}

static bool integer(parser_t *parser, uint16_t *result) {
    space(parser);
    if (parser->cursor == parser->end || *parser->cursor < '1' || *parser->cursor > '9') return false;
    unsigned value = 0;
    while (parser->cursor < parser->end && *parser->cursor >= '0' && *parser->cursor <= '9') {
        value = value * 10u + (unsigned)(*parser->cursor++ - '0');
        if (value > 65535u) return false;
    }
    *result = (uint16_t)value;
    return true;
}

static bool boolean(parser_t *parser, bool *result) {
    space(parser);
    const size_t remaining = (size_t)(parser->end - parser->cursor);
    if (remaining >= 4 && memcmp(parser->cursor, "true", 4) == 0) {
        parser->cursor += 4;
        *result = true;
        return true;
    }
    if (remaining >= 5 && memcmp(parser->cursor, "false", 5) == 0) {
        parser->cursor += 5;
        *result = false;
        return true;
    }
    return false;
}

static bool device_id(const char *id) {
    if (!id || id[36] != 0) return false;
    for (unsigned i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (id[i] != '-') return false;
        } else if (!((id[i] >= '0' && id[i] <= '9') ||
            (id[i] >= 'a' && id[i] <= 'f') || (id[i] >= 'A' && id[i] <= 'F'))) return false;
    }
    return true;
}

static bool parse(const char *body, size_t size, bool phone_request,
    qdd_onboarding_phone_t *phone) {
    if (!body || !phone || size == 0 || size > QDD_ONBOARDING_BODY_LIMIT) return false;
    parser_t parser = {body, body + size};
    qdd_onboarding_phone_t parsed = {0};
    unsigned seen = 0;
    if (!take(&parser, '{')) return false;
    for (;;) {
        char key[16];
        unsigned bit;
        if (!string(&parser, key, sizeof(key)) || !take(&parser, ':')) return false;
        if (strcmp(key, "port") == 0) {
            bit = 1u;
            if (!integer(&parser, &parsed.port)) return false;
        } else if (phone_request && strcmp(key, "deviceId") == 0) {
            bit = 2u;
            if (!string(&parser, parsed.device_id, sizeof(parsed.device_id)) || !device_id(parsed.device_id)) return false;
        } else if (phone_request && strcmp(key, "projecting") == 0) {
            bit = 4u;
            if (!boolean(&parser, &parsed.projecting)) return false;
        } else return false;
        if (seen & bit) return false;
        seen |= bit;
        space(&parser);
        if (parser.cursor == parser.end) return false;
        if (*parser.cursor == '}') {
            parser.cursor++;
            break;
        }
        if (!take(&parser, ',')) return false;
    }
    space(&parser);
    if (parser.cursor != parser.end || seen != (phone_request ? 7u : 1u)) return false;
    *phone = parsed;
    return true;
}

bool qdd_onboarding_parse_phone(const char *body, size_t size, qdd_onboarding_phone_t *phone) {
    return parse(body, size, true, phone);
}

bool qdd_onboarding_parse_pc(const char *body, size_t size, uint16_t *port) {
    if (!port) return false;
    qdd_onboarding_phone_t parsed;
    if (!parse(body, size, false, &parsed)) return false;
    *port = parsed.port;
    return true;
}

bool qdd_onboarding_private_ipv4(const char *ip) {
    if (!ip) return false;
    unsigned octets[4];
    for (unsigned part = 0; part < 4; part++) {
        if (*ip < '0' || *ip > '9') return false;
        const bool zero = *ip == '0';
        unsigned value = 0, length = 0;
        while (*ip >= '0' && *ip <= '9') {
            if (++length > 3 || (zero && length > 1)) return false;
            value = value * 10u + (unsigned)(*ip++ - '0');
            if (value > 255) return false;
        }
        octets[part] = value;
        if (part < 3 && *ip++ != '.') return false;
    }
    if (*ip != 0) return false;
    return octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] == 192 && octets[1] == 168);
}

void qdd_onboarding_model_clear(qdd_onboarding_model_t *model) {
    if (model) memset(model, 0, sizeof(*model));
}

bool qdd_onboarding_model_phone(qdd_onboarding_model_t *model, const char *peer_ip,
    const qdd_onboarding_phone_t *phone, uint64_t now_ms) {
    if (!model || !phone || !phone->port || !device_id(phone->device_id) ||
        !qdd_onboarding_private_ipv4(peer_ip)) return false;
    strcpy(model->view.phone_ip, peer_ip);
    strcpy(model->view.phone_device_id, phone->device_id);
    model->view.phone_port = phone->port;
    model->view.phone_projecting = phone->projecting;
    model->view.phone_seen = true;
    model->phone_registered = true;
    model->phone_seen_ms = now_ms;
    return true;
}

bool qdd_onboarding_model_pc(qdd_onboarding_model_t *model, const char *peer_ip,
    uint16_t port, uint64_t now_ms) {
    if (!model || !port || !qdd_onboarding_private_ipv4(peer_ip)) return false;
    strcpy(model->view.pc_ip, peer_ip);
    model->view.pc_port = port;
    model->pc_registered = true;
    model->pc_seen_ms = now_ms;
    return true;
}

static bool fresh(bool registered, uint64_t seen_ms, uint64_t now_ms) {
    return registered && now_ms >= seen_ms && now_ms - seen_ms < QDD_ONBOARDING_PEER_TTL_MS;
}

qdd_onboarding_view_t qdd_onboarding_model_view(const qdd_onboarding_model_t *model,
    uint64_t now_ms) {
    if (!model) return (qdd_onboarding_view_t){0};
    qdd_onboarding_view_t view = model->view;
    view.phone_fresh = fresh(model->phone_registered, model->phone_seen_ms, now_ms);
    view.pc_fresh = fresh(model->pc_registered, model->pc_seen_ms, now_ms);
    if (!view.phone_fresh) view.phone_projecting = false;
    return view;
}
