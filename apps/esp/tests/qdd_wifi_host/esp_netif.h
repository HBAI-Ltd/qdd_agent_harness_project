#pragma once

#include "esp_err.h"
#include <stdint.h>

typedef struct { int unused; } esp_netif_t;
typedef struct { int unused; } esp_netif_config_t;
typedef struct { uint32_t addr; } esp_ip4_addr_t;
typedef struct { esp_ip4_addr_t ip; } esp_netif_ip_info_t;
typedef struct { esp_netif_ip_info_t ip_info; } ip_event_got_ip_t;
#define ESP_NETIF_DEFAULT_WIFI_STA() ((esp_netif_config_t){0})

esp_err_t esp_netif_init(void);
esp_netif_t *esp_netif_new(const esp_netif_config_t *config);
esp_err_t esp_netif_attach_wifi_station(esp_netif_t *netif);
void esp_netif_destroy_default_wifi(esp_netif_t *netif);
