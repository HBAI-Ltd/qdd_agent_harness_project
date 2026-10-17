#include "qdd_setup_model.h"

#include <string.h>

static const char s_characters[] =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ";

_Static_assert(sizeof(s_characters) == QDD_SETUP_CHARACTER_COUNT + 1,
               "The Wi-Fi keyboard must contain every printable ASCII character");

// Volatile stores keep the best-effort wipe when optimized by the compiler.
static void clear_password(qdd_setup_model_t *model) {
    volatile char *password = model->credentials.password;
    for (size_t i = 0; i < sizeof(model->credentials.password); i++) password[i] = 0;
}

static bool text_length(const char *text, size_t capacity, size_t *length) {
    if (!text) return false;
    for (size_t i = 0; i < capacity; i++) {
        if (!text[i]) {
            *length = i;
            return true;
        }
    }
    return false;
}

// Complete Unicode scalar validation rejects overlong, surrogate and truncated
// sequences before any edit, so byte limits cannot split a displayed character.
static bool valid_utf8(const char *text, size_t length) {
    for (size_t i = 0; i < length;) {
        const uint8_t first = (uint8_t)text[i++];
        if (first < 0x80) continue;
        unsigned following;
        uint32_t codepoint;
        uint32_t minimum;
        if (first >= 0xc2 && first <= 0xdf) {
            following = 1;
            codepoint = first & 0x1fu;
            minimum = 0x80;
        } else if (first >= 0xe0 && first <= 0xef) {
            following = 2;
            codepoint = first & 0x0fu;
            minimum = 0x800;
        } else if (first >= 0xf0 && first <= 0xf4) {
            following = 3;
            codepoint = first & 0x07u;
            minimum = 0x10000;
        } else return false;
        if (length - i < following) return false;
        for (unsigned j = 0; j < following; j++) {
            const uint8_t next = (uint8_t)text[i++];
            if ((next & 0xc0u) != 0x80u) return false;
            codepoint = (codepoint << 6u) | (next & 0x3fu);
        }
        if (codepoint < minimum || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    }
    return true;
}

static unsigned columns(unsigned row) {
    if (row >= QDD_SETUP_KEYBOARD_ROWS) return 0;
    const unsigned remaining = QDD_SETUP_CHARACTER_COUNT - row * QDD_SETUP_KEYBOARD_COLUMNS;
    return remaining < QDD_SETUP_KEYBOARD_COLUMNS ? remaining : QDD_SETUP_KEYBOARD_COLUMNS;
}

static uint8_t step(uint8_t value, unsigned count, bool backwards) {
    return (uint8_t)(backwards ? (value + count - 1) % count : (value + 1) % count);
}

char qdd_setup_character(size_t index) {
    return index < QDD_SETUP_CHARACTER_COUNT ? s_characters[index] : '\0';
}

size_t qdd_setup_key_index(const qdd_setup_model_t *model) {
    if (!model || model->column >= columns(model->row)) return QDD_SETUP_CHARACTER_COUNT;
    return model->row * QDD_SETUP_KEYBOARD_COLUMNS + model->column;
}

unsigned qdd_setup_keyboard_page(const qdd_setup_model_t *model) {
    return model ? model->row / QDD_SETUP_VISIBLE_ROWS : 0;
}

void qdd_setup_exit(qdd_setup_model_t *model) {
    clear_password(model);
    memset(model, 0, sizeof(*model));
    model->page = QDD_SETUP_HOME;
}

qdd_setup_action_t qdd_setup_enter(qdd_setup_model_t *model) {
    qdd_setup_exit(model);
    model->page = QDD_SETUP_LIST;
    return QDD_SETUP_SCAN;
}

void qdd_setup_menu(qdd_setup_model_t *model) {
    qdd_setup_exit(model);
    model->page = QDD_SETUP_MENU;
}

void qdd_setup_help(qdd_setup_model_t *model) {
    qdd_setup_menu(model); model->page = QDD_SETUP_HELP;
}

void qdd_setup_intro(qdd_setup_model_t *model) {
    qdd_setup_help(model);
    model->intro_to_onboarding = true;
}

qdd_setup_action_t qdd_setup_pair(qdd_setup_model_t *model) {
    qdd_setup_menu(model); model->page = QDD_SETUP_PAIR;
    return QDD_SETUP_PAIR_PHONE;
}

static void return_to_list(qdd_setup_model_t *model) {
    clear_password(model);
    model->page = QDD_SETUP_LIST;
    model->error = NULL;
    model->choosing_column = false;
    model->action_index = 0;
}

bool qdd_setup_select(qdd_setup_model_t *model, const char *ssid, bool open) {
    size_t length = 0;
    const bool valid = text_length(ssid, sizeof(model->credentials.ssid), &length) &&
                       length > 0 && valid_utf8(ssid, length);
    // Do not retain the previous network's password on any selection attempt.
    clear_password(model);
    if (!valid) {
        memset(model->credentials.ssid, 0, sizeof(model->credentials.ssid));
        model->open = false;
        qdd_setup_error(model, "网络名称无效");
        return false;
    }
    // memmove also supports selecting the already-staged SSID itself.
    memmove(model->credentials.ssid, ssid, length + 1);
    memset(model->credentials.ssid + length + 1, 0,
           sizeof(model->credentials.ssid) - length - 1);
    model->open = open;
    model->page = open ? QDD_SETUP_ACTIONS : QDD_SETUP_PASSWORD;
    model->choosing_column = false;
    model->action_index = 0;
    model->error = NULL;
    return true;
}

void qdd_setup_error(qdd_setup_model_t *model, const char *static_message) {
    model->page = QDD_SETUP_ERROR;
    model->selection = 0;
    model->error = static_message ? static_message : "连接失败，请重试";
    model->choosing_column = false;
}

bool qdd_setup_append(qdd_setup_model_t *model, const char *utf8) {
    size_t old_length = 0, added = 0;
    if (!text_length(model->credentials.password, sizeof(model->credentials.password), &old_length) ||
        !valid_utf8(model->credentials.password, old_length) ||
        !text_length(utf8, sizeof(model->credentials.password), &added) || !added ||
        !valid_utf8(utf8, added)) {
        model->error = "密码字符无效";
        return false;
    }
    if (old_length + added >= sizeof(model->credentials.password)) {
        model->error = "密码最多64字节";
        return false;
    }
    memmove(model->credentials.password + old_length, utf8, added + 1);
    model->error = NULL;
    return true;
}

bool qdd_setup_delete(qdd_setup_model_t *model) {
    size_t length = 0;
    if (!text_length(model->credentials.password, sizeof(model->credentials.password), &length) ||
        !valid_utf8(model->credentials.password, length)) {
        model->error = "密码字符无效";
        return false;
    }
    if (length) {
        size_t start = length - 1;
        while (start && (((uint8_t)model->credentials.password[start] & 0xc0u) == 0x80u)) start--;
        volatile char *password = model->credentials.password;
        for (size_t i = start; i < sizeof(model->credentials.password); i++) password[i] = 0;
    }
    model->error = NULL;
    return true;
}

static bool ready_to_save(qdd_setup_model_t *model) {
    size_t length = 0;
    if (!text_length(model->credentials.password, sizeof(model->credentials.password), &length) ||
        !valid_utf8(model->credentials.password, length)) {
        model->error = "密码字符无效";
        return false;
    }
    if (!model->open && length < 8) {
        model->error = "密码至少8字节";
        return false;
    }
    if (!qdd_wifi_credentials_valid(&model->credentials)) {
        model->error = length == 64 ? "64字节密码须为十六进制" : "密码长度无效";
        return false;
    }
    return true;
}

qdd_setup_action_t qdd_setup_key(qdd_setup_model_t *model, qdd_setup_key_t key,
                               uint8_t network_count, bool scanning) {
    model->network_count = network_count > QDD_SETUP_NETWORK_LIMIT ?
                           QDD_SETUP_NETWORK_LIMIT : network_count;
    if (model->page == QDD_SETUP_LIST && model->selection > model->network_count + 1) model->selection = model->network_count + 1;
    const bool backwards = key == QDD_SETUP_UP;
    const bool navigate = backwards || key == QDD_SETUP_DOWN;
    switch (model->page) {
    case QDD_SETUP_MENU:
        if (navigate) model->selection = step(model->selection, QDD_SETUP_MENU_ITEMS, backwards);
        else if (key == QDD_SETUP_OK) {
            if (model->selection == 0) return qdd_setup_enter(model);
            if (model->selection == 1) return qdd_setup_pair(model);
            if (model->selection == 2) qdd_setup_help(model);
            else if (model->selection == 3) { qdd_setup_menu(model); model->page = QDD_SETUP_RESET; }
            else { qdd_setup_exit(model); return QDD_SETUP_EXIT; }
        }
        break;
    case QDD_SETUP_RESET:
        if (navigate) model->selection = step(model->selection, 2, backwards);
        else if (key == QDD_SETUP_OK && model->selection == 1) return QDD_SETUP_RESET_DEVICE;
        else if (key == QDD_SETUP_OK || key == QDD_SETUP_LONG_OK) {
            qdd_setup_menu(model); model->selection = 3;
        }
        break;
    case QDD_SETUP_HELP:
        if (model->intro_to_onboarding) {
            if (key == QDD_SETUP_OK) { qdd_setup_exit(model); return QDD_SETUP_EXIT; }
            break;
        }
        if (key == QDD_SETUP_OK || key == QDD_SETUP_LONG_OK) { qdd_setup_menu(model); model->selection = 2; }
        break;
    case QDD_SETUP_PAIR:
        if (navigate) model->selection = step(model->selection, 2, backwards);
        else if (key == QDD_SETUP_LONG_OK || (key == QDD_SETUP_OK && model->selection == 1)) {
            qdd_setup_menu(model); model->selection = 1;
        } else if (key == QDD_SETUP_OK) return QDD_SETUP_PAIR_PHONE;
        break;
    case QDD_SETUP_LIST:
        if (scanning) {
            // The busy view has one action: leave without cancelling or
            // restarting the background scan. Never select an old SSID.
            model->selection = 0;
            model->error = NULL;
            if (key == QDD_SETUP_OK || key == QDD_SETUP_LONG_OK) qdd_setup_menu(model);
            break;
        }
        if (key == QDD_SETUP_LONG_OK ||
            (key == QDD_SETUP_OK && model->selection == model->network_count + 1)) {
            qdd_setup_menu(model);
            return QDD_SETUP_NONE;
        }
        if (navigate) {
            model->selection = step(model->selection, model->network_count + 2, backwards);
            model->error = NULL;
        } else if (key == QDD_SETUP_OK) {
            if (model->selection < model->network_count) {
                return QDD_SETUP_SELECT;
            } else {
                model->selection = 0;
                model->error = NULL;
                return QDD_SETUP_SCAN;
            }
        }
        break;
    case QDD_SETUP_PASSWORD:
        if (key == QDD_SETUP_LONG_OK) {
            model->page = QDD_SETUP_ACTIONS;
            model->action_index = 0;
            model->choosing_column = false;
            model->error = NULL;
        } else if (navigate) {
            if (model->choosing_column) {
                model->column = step(model->column, columns(model->row), backwards);
            } else {
                model->row = step(model->row, QDD_SETUP_KEYBOARD_ROWS, backwards);
                if (model->column >= columns(model->row)) model->column = columns(model->row) - 1;
            }
            model->error = NULL;
        } else if (key == QDD_SETUP_OK) {
            if (model->choosing_column) {
                const char character[] = {qdd_setup_character(qdd_setup_key_index(model)), 0};
                (void)qdd_setup_append(model, character);
                model->choosing_column = false;
            } else model->choosing_column = true;
        }
        break;
    case QDD_SETUP_ACTIONS:
        if (navigate) {
            model->action_index = step(model->action_index, QDD_SETUP_ACTION_COUNT, backwards);
            model->error = NULL;
        } else if (key == QDD_SETUP_LONG_OK) {
            return_to_list(model);
        } else if (key == QDD_SETUP_OK) {
            if (model->action_index == 0) {
                if (ready_to_save(model)) {
                    model->page = QDD_SETUP_CONNECTING;
                    model->selection = 0;
                    model->error = NULL;
                    return QDD_SETUP_SAVE;
                }
            } else if (model->action_index == 1) {
                model->page = QDD_SETUP_PASSWORD;
                model->choosing_column = false;
            } else if (model->action_index == 2) {
                (void)qdd_setup_delete(model);
                model->page = QDD_SETUP_PASSWORD;
                model->choosing_column = false;
            } else if (model->action_index == 3) {
                clear_password(model);
                model->page = QDD_SETUP_PASSWORD;
                model->choosing_column = false;
                model->error = NULL;
            } else return_to_list(model);
        }
        break;
    case QDD_SETUP_CONNECTING:
        if (key == QDD_SETUP_LONG_OK || key == QDD_SETUP_OK) return_to_list(model);
        break;
    case QDD_SETUP_ERROR:
        if (navigate) model->selection = step(model->selection, 2, backwards);
        if (key == QDD_SETUP_LONG_OK) return_to_list(model);
        else if (key == QDD_SETUP_OK) {
            if (model->selection == 1) return_to_list(model);
            else model->page = model->credentials.ssid[0] ? QDD_SETUP_PASSWORD : QDD_SETUP_LIST;
            model->selection = 0;
            model->error = NULL;
            model->choosing_column = false;
        }
        break;
    case QDD_SETUP_HOME:
        break;
    }
    return QDD_SETUP_NONE;
}
