#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define QDD_ONBOARDING_HTTP_PORT 3334u
#define QDD_ONBOARDING_DISCOVERY_PORT 3335u
#define QDD_ONBOARDING_BODY_LIMIT 256u
#define QDD_ONBOARDING_PEER_TTL_MS 15000u
#define QDD_ONBOARDING_DEVICE_ID_SIZE 37u

typedef struct {
    char device_id[QDD_ONBOARDING_DEVICE_ID_SIZE];
    uint16_t port;
    bool projecting;
} qdd_onboarding_phone_t;

typedef struct {
    bool downloaded;
    bool phone_seen;
    bool phone_fresh;
    bool phone_projecting;
    bool pc_fresh;
    char phone_ip[16];
    char phone_device_id[QDD_ONBOARDING_DEVICE_ID_SIZE];
    char pc_ip[16];
    uint16_t phone_port;
    uint16_t pc_port;
} qdd_onboarding_view_t;

typedef struct {
    qdd_onboarding_view_t view;
    uint64_t phone_seen_ms;
    uint64_t pc_seen_ms;
    bool phone_registered;
    bool pc_registered;
} qdd_onboarding_model_t;

bool qdd_onboarding_private_ipv4(const char *ip);
bool qdd_onboarding_parse_phone(const char *body, size_t size, qdd_onboarding_phone_t *phone);
bool qdd_onboarding_parse_pc(const char *body, size_t size, uint16_t *port);
void qdd_onboarding_model_clear(qdd_onboarding_model_t *model);
void qdd_onboarding_model_invalidate_network(qdd_onboarding_model_t *model);
bool qdd_onboarding_model_phone(qdd_onboarding_model_t *model, const char *peer_ip,
    const qdd_onboarding_phone_t *phone, uint64_t now_ms);
bool qdd_onboarding_model_pc(qdd_onboarding_model_t *model, const char *peer_ip,
    uint16_t port, uint64_t now_ms);
qdd_onboarding_view_t qdd_onboarding_model_view(const qdd_onboarding_model_t *model,
    uint64_t now_ms);
