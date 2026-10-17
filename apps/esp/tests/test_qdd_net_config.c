#include "qdd_net_config.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    qdd_net_command_t command;
    assert(qdd_net_parse("QDDNET/1 1 WIFI_SSID V2lGaQ==", &command));
    assert(command.id == 1 && command.operation == QDD_NET_SSID && command.length == 4);
    assert(strcmp((char *)command.data, "WiFi") == 0);
    assert(qdd_net_parse("QDDNET/1 2147483647 WIFI_PASS -", &command) && !command.length);
    const char *bad[] = {"QDDNET/1 0 WIFI_STATUS", "QDDNET/1 2147483648 WIFI_STATUS",
        "QDDNET/1 1  WIFI_STATUS", "QDDNET/1 1 WIFI_STATUS ", "QDDNET/1 1 WIFI_SSID -",
        "QDDNET/1 1 WIFI_SSID AA==", "QDDNET/1 1 WIFI_PASS Zh==", "QDDNET/1 1 WIFI_PASS Zm9=",
        "QDDNET/1 1 WIFI_PASS Zg==Zg==", "QDDNET/1 1 WIFI_PASS =g==", "QDDNET/1 1 WIFI_PASS Zg=",
        "QDDNET/1 1 WIFI_PASS Zg== ", "QDDNET/1 1 WIFI_PASS Zg-_", "QDDNET/1 1 WIFI_OTHER"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) assert(!qdd_net_parse(bad[i], &command));
    char oversized[180];
    memset(oversized, 'A', sizeof(oversized)); oversized[179] = 0;
    assert(!qdd_net_parse(oversized, &command));
    qdd_wifi_credentials_t credentials = {.ssid = "WiFi", .password = "12345678"};
    assert(qdd_wifi_credentials_valid(&credentials));
    credentials.password[0] = 0;
    assert(qdd_wifi_credentials_valid(&credentials));
    strcpy(credentials.password, "1234567");
    assert(!qdd_wifi_credentials_valid(&credentials));
    memset(credentials.password, 'a', 64); credentials.password[64] = 0;
    assert(qdd_wifi_credentials_valid(&credentials));
    credentials.password[63] = '!';
    assert(!qdd_wifi_credentials_valid(&credentials));
    memset(credentials.ssid, 's', 32); credentials.ssid[32] = 0;
    strcpy(credentials.password, "12345678");
    assert(qdd_wifi_credentials_valid(&credentials));
    credentials.ssid[32] = 's';
    assert(!qdd_wifi_credentials_valid(&credentials));
    puts("QDD USB Wi-Fi configuration strict parsing and credential bounds tests: PASS");
}
