#pragma once

#include "esp_err.h"
#include <stdint.h>

typedef const char *esp_event_base_t;
typedef void *esp_event_handler_instance_t;
typedef void (*esp_event_handler_t)(void *, esp_event_base_t, int32_t, void *);
extern const char qdd_test_wifi_event[];
extern const char qdd_test_ip_event[];
#define WIFI_EVENT qdd_test_wifi_event
#define IP_EVENT qdd_test_ip_event
#define ESP_EVENT_ANY_ID (-1)
#define WIFI_EVENT_STA_DISCONNECTED 1
#define WIFI_EVENT_SCAN_DONE 2
#define IP_EVENT_STA_GOT_IP 3
#define IP_EVENT_STA_LOST_IP 4
#define WIFI_EVENT_STA_CONNECTED 5
#define WIFI_EVENT_STA_BEACON_TIMEOUT 6

esp_err_t esp_event_loop_create_default(void);
esp_err_t esp_event_handler_instance_register(esp_event_base_t base, int32_t id,
    esp_event_handler_t handler, void *context, esp_event_handler_instance_t *instance);
esp_err_t esp_event_handler_instance_unregister(esp_event_base_t base, int32_t id,
    esp_event_handler_instance_t instance);
