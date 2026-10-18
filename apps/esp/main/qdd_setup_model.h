#pragma once

#include "qdd_net_config.h"

#define QDD_SETUP_NETWORK_LIMIT 64u
#define QDD_SETUP_CHARACTER_COUNT 95u
#define QDD_SETUP_KEYBOARD_COLUMNS 6u
#define QDD_SETUP_KEYBOARD_ROWS 16u
#define QDD_SETUP_VISIBLE_ROWS 4u
#define QDD_SETUP_ACTION_COUNT 5u
#define QDD_SETUP_MENU_ITEMS 6u

typedef enum {
    QDD_SETUP_HOME, QDD_SETUP_LIST, QDD_SETUP_PASSWORD,
    QDD_SETUP_ACTIONS, QDD_SETUP_CONNECTING, QDD_SETUP_ERROR,
    QDD_SETUP_MENU, QDD_SETUP_HELP, QDD_SETUP_PAIR, QDD_SETUP_RESET,
    QDD_SETUP_DOWNLOAD
} qdd_setup_page_t;

typedef enum {
    QDD_SETUP_UP, QDD_SETUP_DOWN, QDD_SETUP_OK, QDD_SETUP_LONG_OK
} qdd_setup_key_t;

typedef enum {
    QDD_SETUP_NONE, QDD_SETUP_SCAN, QDD_SETUP_SELECT,
    QDD_SETUP_SAVE, QDD_SETUP_EXIT, QDD_SETUP_PAIR_PHONE, QDD_SETUP_RESET_DEVICE
} qdd_setup_action_t;

typedef struct {
    qdd_setup_page_t page;
    uint8_t selection;
    uint8_t network_count;
    uint8_t row;
    uint8_t column;
    uint8_t action_index;
    bool choosing_column;
    bool open;
    bool intro_to_onboarding;
    qdd_wifi_credentials_t credentials;
    // Only static, non-secret messages may be supplied to qdd_setup_error().
    const char *error;
} qdd_setup_model_t;

// Pure UI state only. The caller owns networking, pausing and the physical lock.
qdd_setup_action_t qdd_setup_enter(qdd_setup_model_t *model);
void qdd_setup_menu(qdd_setup_model_t *model);
void qdd_setup_help(qdd_setup_model_t *model);
void qdd_setup_intro(qdd_setup_model_t *model);
qdd_setup_action_t qdd_setup_pair(qdd_setup_model_t *model);
qdd_setup_action_t qdd_setup_key(qdd_setup_model_t *model, qdd_setup_key_t key,
                               uint8_t network_count, bool scanning);
// Rejects invalid UTF-8 and SSIDs exceeding 32 bytes; never truncates a name.
bool qdd_setup_select(qdd_setup_model_t *model, const char *ssid, bool open);
void qdd_setup_error(qdd_setup_model_t *model, const char *static_message);
void qdd_setup_exit(qdd_setup_model_t *model);

// The 95 printable ASCII characters occur exactly once, including space.
char qdd_setup_character(size_t index);
size_t qdd_setup_key_index(const qdd_setup_model_t *model);
unsigned qdd_setup_keyboard_page(const qdd_setup_model_t *model);

// Byte-bounded UTF-8 edits; invalid/oversized input leaves the password intact.
bool qdd_setup_append(qdd_setup_model_t *model, const char *utf8);
bool qdd_setup_delete(qdd_setup_model_t *model);
