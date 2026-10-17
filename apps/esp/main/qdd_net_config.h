#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct { char ssid[33]; char password[65]; } qdd_wifi_credentials_t;
typedef enum { QDD_NET_STATUS, QDD_NET_SSID, QDD_NET_PASSWORD, QDD_NET_SAVE,
               QDD_NET_CLEAR, QDD_NET_RETRY } qdd_net_operation_t;
typedef struct {
    uint32_t id;
    qdd_net_operation_t operation;
    uint8_t data[65];
    size_t length;
} qdd_net_command_t;

bool qdd_net_parse(const char *line, qdd_net_command_t *command);
bool qdd_wifi_credentials_valid(const qdd_wifi_credentials_t *credentials);
