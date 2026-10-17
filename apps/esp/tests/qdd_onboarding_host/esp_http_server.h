#pragma once
#include "esp_err.h"
#include <stddef.h>
#include <sys/types.h>
typedef void *httpd_handle_t;
typedef struct {
    size_t content_len;
    void *user_ctx;
    const char *body;
    const char *content_type;
    const char *origin;
    size_t received;
} httpd_req_t;
typedef struct {
    unsigned server_port, task_priority, stack_size, max_open_sockets, max_uri_handlers;
    unsigned lru_purge_enable, recv_wait_timeout, send_wait_timeout;
} httpd_config_t;
#define HTTPD_DEFAULT_CONFIG() {0}
#define HTTP_GET 0
#define HTTP_POST 1
#define HTTPD_RESP_USE_STRLEN (-1)
typedef struct {
    const char *uri;
    int method;
    esp_err_t (*handler)(httpd_req_t *);
    void *user_ctx;
} httpd_uri_t;
esp_err_t httpd_start(httpd_handle_t *handle, const httpd_config_t *config);
esp_err_t httpd_stop(httpd_handle_t handle);
esp_err_t httpd_register_uri_handler(httpd_handle_t handle, const httpd_uri_t *uri);
int httpd_req_to_sockfd(httpd_req_t *request);
esp_err_t httpd_resp_set_status(httpd_req_t *request, const char *status);
esp_err_t httpd_resp_set_type(httpd_req_t *request, const char *type);
esp_err_t httpd_resp_set_hdr(httpd_req_t *request, const char *key, const char *value);
esp_err_t httpd_resp_send(httpd_req_t *request, const char *body, ssize_t length);
esp_err_t httpd_resp_send_chunk(httpd_req_t *request, const char *body, ssize_t length);
size_t httpd_req_get_hdr_value_len(httpd_req_t *request, const char *key);
esp_err_t httpd_req_get_hdr_value_str(httpd_req_t *request, const char *key, char *value, size_t size);
int httpd_req_recv(httpd_req_t *request, char *body, size_t size);
