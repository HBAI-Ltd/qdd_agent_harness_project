#include "qdd_onboarding_model.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define UUID "28c16ea2-c6ee-4b5d-8307-29b20df14bab"
#define PHONE "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":true}"

static void test_parse_phone(void) {
    qdd_onboarding_phone_t phone;
    assert(qdd_onboarding_parse_phone(PHONE, strlen(PHONE), &phone));
    assert(strcmp(phone.device_id, UUID) == 0 && phone.port == 8791 && phone.projecting);
    const char *reordered = " \r\n{\"projecting\": false, \"port\" : 65535, \"deviceId\":\"" UUID "\"}\t";
    assert(qdd_onboarding_parse_phone(reordered, strlen(reordered), &phone));
    assert(phone.port == 65535 && !phone.projecting);
    const char *invalid[] = {
        "", "{}", "[]", "null", PHONE "x", PHONE ",", "{\"port\":8791}",
        "{\"deviceId\":\"not-a-device\",\"port\":8791,\"projecting\":true}",
        "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":1}",
        "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":truefalse}",
        "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":true,\"ip\":\"10.0.0.1\"}",
        "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":true,\"port\":3333}",
        "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":true,}",
        "{\"deviceId\":\"" UUID "\",\"port\":8791,\"projecting\":true,\"projecting\":false}",
        "{\"deviceId\":\"28c16ea2\\u002dc6ee-4b5d-8307-29b20df14bab\",\"port\":8791,\"projecting\":true}",
        "{\"deviceId\":\"28c16ea2-c6ee-4b5d-8307-29b20df14baG\",\"port\":8791,\"projecting\":true}"
    };
    const qdd_onboarding_phone_t preserved = phone;
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        assert(!qdd_onboarding_parse_phone(invalid[i], strlen(invalid[i]), &phone));
        assert(memcmp(&preserved, &phone, sizeof(phone)) == 0);
    }
    assert(!qdd_onboarding_parse_phone(NULL, 1, &phone));
    assert(!qdd_onboarding_parse_phone(PHONE, strlen(PHONE), NULL));
    assert(!qdd_onboarding_parse_phone(PHONE, strlen(PHONE) + 1, &phone));
    char limit[QDD_ONBOARDING_BODY_LIMIT + 1];
    memset(limit, ' ', sizeof(limit));
    memcpy(limit, PHONE, strlen(PHONE));
    assert(qdd_onboarding_parse_phone(limit, QDD_ONBOARDING_BODY_LIMIT, &phone));
    assert(!qdd_onboarding_parse_phone(limit, sizeof(limit), &phone));
    for (size_t i = 0; i < strlen(PHONE); i++) assert(!qdd_onboarding_parse_phone(PHONE, i, &phone));
}

static void test_parse_pc(void) {
    uint16_t port = 100;
    const char *valid[] = {"{\"port\":1}", "{\"port\":8790}", " { \"port\" : 65535 }\n"};
    for (size_t i = 0; i < sizeof(valid) / sizeof(valid[0]); i++) {
        assert(qdd_onboarding_parse_pc(valid[i], strlen(valid[i]), &port));
    }
    const char *invalid[] = {"{\"port\":0}", "{\"port\":65536}", "{\"port\":999999999999999999}",
        "{\"port\":-1}", "{\"port\":+1}", "{\"port\":01}", "{\"port\":1.5}",
        "{\"port\":1e3}", "{\"port\":\"8790\"}", "{\"port\":null}",
        "{\"port\":1,\"port\":2}", "{\"port\":1,\"ip\":\"10.0.0.1\"}", PHONE};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        port = 1234;
        assert(!qdd_onboarding_parse_pc(invalid[i], strlen(invalid[i]), &port));
        assert(port == 1234);
    }
    assert(!qdd_onboarding_parse_pc("{\"port\":1}", 10, NULL));
}

static void test_private_addresses(void) {
    const char *valid[] = {"10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.0.1"};
    for (size_t i = 0; i < sizeof(valid) / sizeof(valid[0]); i++) assert(qdd_onboarding_private_ipv4(valid[i]));
    const char *invalid[] = {"", "127.0.0.1", "0.0.0.0", "169.254.0.1", "172.15.0.1", "172.32.0.1", "192.169.1.1",
        "255.255.255.255", "224.0.0.1", "8.8.8.8", "::1", "10.0.0", "10.0.0.256", "10.0.0.1.1", "10.0.0.1x",
        "10.0.0.-1", "10.0.0.+1", "010.0.0.1", "10.0.0.01", "10..0.1", "10.0.0.", "10.0.0.1000"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) assert(!qdd_onboarding_private_ipv4(invalid[i]));
    assert(!qdd_onboarding_private_ipv4(NULL));
}

static void test_registration_and_expiry(void) {
    qdd_onboarding_model_t model = {0};
    qdd_onboarding_phone_t phone;
    assert(qdd_onboarding_parse_phone(PHONE, strlen(PHONE), &phone));
    qdd_onboarding_view_t view = qdd_onboarding_model_view(&model, 0);
    assert(!view.phone_seen && !view.phone_fresh && !view.phone_projecting && !view.pc_fresh);
    assert(qdd_onboarding_model_phone(&model, "10.65.201.94", &phone, 0));
    assert(qdd_onboarding_model_pc(&model, "192.168.1.2", 8790, 2));
    view = qdd_onboarding_model_view(&model, 14999);
    assert(view.phone_seen && view.phone_fresh && view.phone_projecting && view.pc_fresh);
    assert(strcmp(view.phone_device_id, UUID) == 0 && view.phone_port == 8791 && view.pc_port == 8790);
    view = qdd_onboarding_model_view(&model, 15000);
    assert(view.phone_seen && !view.phone_fresh && !view.phone_projecting && view.pc_fresh);
    assert(!view.phone_ip[0] && !view.phone_device_id[0] && !view.phone_port);
    view = qdd_onboarding_model_view(&model, 15002);
    assert(!view.pc_fresh && !view.pc_ip[0] && !view.pc_port);
    phone.projecting = false;
    assert(qdd_onboarding_model_phone(&model, "172.20.10.2", &phone, 20000));
    view = qdd_onboarding_model_view(&model, 20000);
    assert(view.phone_seen && view.phone_fresh && !view.phone_projecting);
    assert(strcmp(view.phone_ip, "172.20.10.2") == 0);
    view = qdd_onboarding_model_view(&model, 19999);
    assert(view.phone_seen && !view.phone_fresh && !view.phone_projecting); // Clock rollback fails closed.
    const qdd_onboarding_model_t preserved = model;
    assert(!qdd_onboarding_model_phone(&model, "8.8.8.8", &phone, 20000));
    assert(!qdd_onboarding_model_pc(&model, "10.0.0.1", 0, 20000));
    memset(phone.device_id, 'x', sizeof(phone.device_id));
    assert(!qdd_onboarding_model_phone(&model, "10.0.0.1", &phone, 20000));
    assert(memcmp(&model, &preserved, sizeof(model)) == 0);
    model.view.downloaded = true;
    qdd_onboarding_model_clear(&model);
    view = qdd_onboarding_model_view(&model, 20000);
    assert(!view.downloaded && !view.phone_seen && !view.phone_fresh && !view.pc_fresh);
    assert(view.phone_ip[0] == 0 && view.pc_ip[0] == 0 && view.phone_device_id[0] == 0);
    assert(!qdd_onboarding_model_phone(NULL, "10.0.0.1", &phone, 0));
    assert(!qdd_onboarding_model_pc(NULL, "10.0.0.1", 8790, 0));
    qdd_onboarding_model_clear(NULL);
    view = qdd_onboarding_model_view(NULL, 0);
    assert(!view.phone_seen);
}

static void test_network_invalidation_keeps_installation(void) {
    qdd_onboarding_model_t model = {0};
    qdd_onboarding_phone_t phone;
    assert(qdd_onboarding_parse_phone(PHONE, strlen(PHONE), &phone));
    model.view.downloaded = true;
    assert(qdd_onboarding_model_phone(&model, "10.0.0.2", &phone, 100));
    assert(qdd_onboarding_model_pc(&model, "10.0.0.3", 8790, 100));
    qdd_onboarding_model_invalidate_network(&model);
    qdd_onboarding_view_t view = qdd_onboarding_model_view(&model, 101);
    assert(view.downloaded && view.phone_seen && !view.phone_fresh && !view.pc_fresh && !view.phone_projecting);
    assert(!view.phone_ip[0] && !view.phone_device_id[0] && !view.phone_port && !view.pc_ip[0] && !view.pc_port);
    assert(!model.phone_registered && !model.pc_registered && !model.phone_seen_ms && !model.pc_seen_ms);
    // A different network requires fresh registration, not an old endpoint.
    phone.projecting = false;
    assert(qdd_onboarding_model_phone(&model, "192.168.1.2", &phone, 200));
    view = qdd_onboarding_model_view(&model, 200);
    assert(view.phone_seen && view.phone_fresh && !view.phone_projecting && !view.pc_fresh);
    assert(strcmp(view.phone_ip, "192.168.1.2") == 0);
    phone.projecting = true;
    assert(qdd_onboarding_model_phone(&model, "192.168.1.2", &phone, 201));
    assert(qdd_onboarding_model_pc(&model, "192.168.1.3", 8790, 201));
    view = qdd_onboarding_model_view(&model, 201);
    assert(view.phone_projecting && view.phone_fresh && view.pc_fresh && view.downloaded);
    qdd_onboarding_model_clear(&model); // Only full clear removes the milestones.
    view = qdd_onboarding_model_view(&model, 201);
    assert(!view.downloaded && !view.phone_seen && !view.phone_fresh && !view.pc_fresh);
    qdd_onboarding_model_invalidate_network(NULL);
}

int main(void) {
    test_parse_phone();
    test_parse_pc();
    test_private_addresses();
    test_registration_and_expiry();
    test_network_invalidation_keeps_installation();
    puts("QDD onboarding bounded JSON, peer address, registration and expiry tests: PASS");
    return 0;
}
