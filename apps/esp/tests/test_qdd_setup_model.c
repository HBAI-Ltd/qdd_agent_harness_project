#include "qdd_setup_model.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static qdd_setup_action_t key(qdd_setup_model_t *model, qdd_setup_key_t value) {
    return qdd_setup_key(model, value, 3, false);
}

static void select_network(qdd_setup_model_t *model, bool open) {
    assert(qdd_setup_enter(model) == QDD_SETUP_SCAN);
    assert(qdd_setup_select(model, "Test network", open));
    assert(model->open == open);
    assert(model->page == (open ? QDD_SETUP_ACTIONS : QDD_SETUP_PASSWORD));
    assert(model->credentials.password[0] == 0);
}

static void password_is_clear(const qdd_setup_model_t *model) {
    for (size_t i = 0; i < sizeof(model->credentials.password); i++) {
        assert(model->credentials.password[i] == 0);
    }
}

static void test_list(void) {
    qdd_setup_model_t model = {0};
    assert(qdd_setup_enter(&model) == QDD_SETUP_SCAN);
    assert(model.page == QDD_SETUP_LIST && model.selection == 0);
    assert(qdd_setup_key(&model, QDD_SETUP_DOWN, 0, true) == QDD_SETUP_NONE);
    assert(model.selection == 0 && model.error == NULL);
    model.selection = 40;
    assert(qdd_setup_key(&model, QDD_SETUP_UP, 64, true) == QDD_SETUP_NONE);
    assert(model.selection == 0 && model.error == NULL);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 0, true) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_MENU);

    assert(qdd_setup_enter(&model) == QDD_SETUP_SCAN);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 0, false) == QDD_SETUP_SCAN);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 3, false) == QDD_SETUP_SELECT);
    assert(model.selection == 0);
    assert(key(&model, QDD_SETUP_UP) == QDD_SETUP_NONE && model.selection == 4);
    assert(key(&model, QDD_SETUP_UP) == QDD_SETUP_NONE && model.selection == 3);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_SCAN && model.selection == 0);
    for (unsigned i = 0; i < 3; i++) (void)key(&model, QDD_SETUP_DOWN);
    assert(model.selection == 3);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 3, true) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_MENU); // Busy OK always returns, never rescans/selects.
    (void)qdd_setup_enter(&model);
    model.selection = 3;
    (void)key(&model, QDD_SETUP_DOWN);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_MENU);

    (void)qdd_setup_enter(&model);
    assert(qdd_setup_key(&model, QDD_SETUP_UP, 255, false) == QDD_SETUP_NONE);
    assert(model.network_count == 64 && model.selection == 65);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 1, false) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_MENU); // A shrinking scan list clamps safely.
    (void)qdd_setup_enter(&model);
    assert(key(&model, QDD_SETUP_LONG_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_MENU);
}

static void test_short_press_menu_navigation(void) {
    qdd_setup_model_t model = {0}; qdd_setup_menu(&model);
    assert(model.page == QDD_SETUP_MENU && model.selection == 0);
    assert(qdd_setup_key(&model, QDD_SETUP_UP, 0, false) == QDD_SETUP_NONE && model.selection == 4);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_EXIT && model.page == QDD_SETUP_HOME);
    qdd_setup_menu(&model);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_SCAN && model.page == QDD_SETUP_LIST);
    for (unsigned i = 0; i < 4; i++) key(&model, QDD_SETUP_DOWN);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE && model.page == QDD_SETUP_MENU);
    key(&model, QDD_SETUP_DOWN);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_PAIR_PHONE && model.page == QDD_SETUP_PAIR);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_PAIR_PHONE);
    key(&model, QDD_SETUP_DOWN); key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_MENU && model.selection == 1);
    key(&model, QDD_SETUP_DOWN); key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_HELP);
    key(&model, QDD_SETUP_OK); assert(model.page == QDD_SETUP_MENU && model.selection == 2);
    key(&model, QDD_SETUP_DOWN); key(&model, QDD_SETUP_DOWN); assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_EXIT);
    select_network(&model, false); qdd_setup_error(&model, "连接失败，请重试");
    key(&model, QDD_SETUP_DOWN); key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_LIST); password_is_clear(&model);
}

static void test_settings_download_is_display_only(void) {
    qdd_setup_model_t model = {0}; qdd_setup_menu(&model);
    for (unsigned i = 0; i < 4; i++) assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE);
    assert(model.selection == 4);
    // This settings item must only show the download page, never exit, scan,
    // pair, save credentials or reset the controller.
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page != QDD_SETUP_MENU && model.page != QDD_SETUP_HOME && model.page != QDD_SETUP_RESET);
}

static void test_first_connection_intro(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false);
    assert(qdd_setup_append(&model, "12345678"));
    qdd_setup_intro(&model);
    assert(model.page == QDD_SETUP_HELP && model.intro_to_onboarding);
    password_is_clear(&model);
    assert(key(&model, QDD_SETUP_UP) == QDD_SETUP_NONE && model.page == QDD_SETUP_HELP);
    assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE && model.page == QDD_SETUP_HELP);
    assert(key(&model, QDD_SETUP_LONG_OK) == QDD_SETUP_NONE && model.intro_to_onboarding);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_EXIT && model.page == QDD_SETUP_HOME);
    assert(!model.intro_to_onboarding && !model.credentials.ssid[0]);
    qdd_setup_help(&model);
    assert(!model.intro_to_onboarding && model.page == QDD_SETUP_HELP);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE && model.page == QDD_SETUP_MENU && model.selection == 2);
    qdd_setup_intro(&model);
    qdd_setup_menu(&model);
    assert(!model.intro_to_onboarding); // A new settings context never inherits intro routing.
}

static void test_keyboard_reachability(void) {
    bool seen[128] = {false};
    qdd_setup_model_t model = {0};
    for (size_t index = 0; index < QDD_SETUP_CHARACTER_COUNT; index++) {
        select_network(&model, false);
        const unsigned row = (unsigned)index / QDD_SETUP_KEYBOARD_COLUMNS;
        const unsigned column = (unsigned)index % QDD_SETUP_KEYBOARD_COLUMNS;
        for (unsigned i = 0; i < row; i++) (void)key(&model, QDD_SETUP_DOWN);
        assert(model.row == row && !model.choosing_column);
        assert(qdd_setup_keyboard_page(&model) == row / QDD_SETUP_VISIBLE_ROWS);
        assert(model.credentials.password[0] == 0); // Row navigation never types.
        (void)key(&model, QDD_SETUP_OK);
        assert(model.choosing_column);
        for (unsigned i = 0; i < column; i++) (void)key(&model, QDD_SETUP_DOWN);
        assert(model.row == row && model.column == column);
        assert(qdd_setup_key_index(&model) == index);
        assert(model.credentials.password[0] == 0); // Column navigation never types.
        (void)key(&model, QDD_SETUP_OK);
        assert(!model.choosing_column);
        const unsigned char character = (unsigned char)qdd_setup_character(index);
        assert(character >= 32 && character <= 126 && !seen[character]);
        seen[character] = true;
        assert(model.credentials.password[0] == (char)character);
        assert(model.credentials.password[1] == 0);
    }
    for (unsigned character = 32; character <= 126; character++) assert(seen[character]);
    assert(qdd_setup_character(QDD_SETUP_CHARACTER_COUNT) == 0);
    assert(qdd_setup_character((size_t)-1) == 0);
    assert(qdd_setup_key_index(NULL) == QDD_SETUP_CHARACTER_COUNT);
    assert(qdd_setup_keyboard_page(NULL) == 0);
}

static void test_focus_and_last_row(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false);
    (void)key(&model, QDD_SETUP_OK);
    (void)key(&model, QDD_SETUP_UP);
    assert(model.column == 5 && model.row == 0 && model.choosing_column);
    (void)key(&model, QDD_SETUP_OK);
    assert(strcmp(model.credentials.password, "5") == 0);
    (void)key(&model, QDD_SETUP_UP); // Row 0 -> 15, six columns -> five.
    assert(model.row == 15 && model.column == 4);
    assert(qdd_setup_key_index(&model) == 94);
    assert(qdd_setup_character(qdd_setup_key_index(&model)) == ' ');
    (void)key(&model, QDD_SETUP_OK);
    (void)key(&model, QDD_SETUP_DOWN);
    assert(model.column == 0 && model.row == 15);
    (void)key(&model, QDD_SETUP_UP);
    assert(model.column == 4 && model.row == 15);
    (void)key(&model, QDD_SETUP_OK);
    assert(strcmp(model.credentials.password, "5 ") == 0);
    (void)key(&model, QDD_SETUP_DOWN);
    assert(model.row == 0 && model.column == 4);
    (void)key(&model, QDD_SETUP_LONG_OK);
    assert(model.page == QDD_SETUP_ACTIONS && model.action_index == 0);
    (void)key(&model, QDD_SETUP_DOWN);
    (void)key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_PASSWORD && strcmp(model.credentials.password, "5 ") == 0);
    // Opening the completion menu must have a way to continue without deleting.
    (void)key(&model, QDD_SETUP_LONG_OK);
    (void)key(&model, QDD_SETUP_DOWN);
    (void)key(&model, QDD_SETUP_DOWN);
    (void)key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_PASSWORD && model.row == 0 && model.column == 4);
    assert(!model.choosing_column && strcmp(model.credentials.password, "5") == 0);
}

static void test_utf8_and_limits(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false);
    assert(qdd_setup_append(&model, "Aé中😀"));
    assert(strlen(model.credentials.password) == 10);
    assert(qdd_setup_delete(&model));
    assert(strcmp(model.credentials.password, "Aé中") == 0);
    assert(qdd_setup_delete(&model));
    assert(strcmp(model.credentials.password, "Aé") == 0);
    assert(qdd_setup_delete(&model));
    assert(strcmp(model.credentials.password, "A") == 0);
    assert(qdd_setup_delete(&model));
    assert(qdd_setup_delete(&model));
    password_is_clear(&model);

    const char *invalid[] = {"\x80", "\xc0\xaf", "\xc1\xbf", "\xc2", "\xe2\x82",
        "\xed\xa0\x80", "\xe0\x80\x80", "\xf0\x80\x80\x80", "\xf4\x90\x80\x80",
        "\xf5\x80\x80\x80", "\xe2\x28\xa1", "\xff"};
    assert(qdd_setup_append(&model, "preserved"));
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        assert(!qdd_setup_append(&model, invalid[i]));
        assert(strcmp(model.credentials.password, "preserved") == 0);
        assert(strcmp(model.error, "密码字符无效") == 0);
    }
    assert(!qdd_setup_append(&model, NULL));
    assert(!qdd_setup_append(&model, ""));

    select_network(&model, false);
    char ascii64[65];
    memset(ascii64, 'a', 64);
    ascii64[64] = 0;
    assert(qdd_setup_append(&model, ascii64));
    assert(strlen(model.credentials.password) == 64);
    assert(!qdd_setup_append(&model, "x"));
    assert(strcmp(model.error, "密码最多64字节") == 0);
    assert(strcmp(model.credentials.password, ascii64) == 0);
    assert(qdd_setup_delete(&model));
    assert(strlen(model.credentials.password) == 63);
    assert(!qdd_setup_append(&model, "é"));
    assert(strlen(model.credentials.password) == 63);
    assert(qdd_setup_append(&model, "x"));
    assert(strlen(model.credentials.password) == 64);

    select_network(&model, false);
    for (unsigned i = 0; i < 20; i++) assert(qdd_setup_append(&model, "中"));
    assert(qdd_setup_append(&model, "😀"));
    assert(strlen(model.credentials.password) == 64);
    assert(!qdd_setup_append(&model, "中"));
    assert(qdd_setup_delete(&model));
    assert(strlen(model.credentials.password) == 60);
    assert(qdd_setup_append(&model, "中"));
    assert(strlen(model.credentials.password) == 63);

    model.credentials.password[0] = (char)0x80;
    const qdd_wifi_credentials_t before = model.credentials;
    assert(!qdd_setup_delete(&model));
    assert(!qdd_setup_append(&model, "x"));
    assert(memcmp(&before, &model.credentials, sizeof(before)) == 0);
    memset(model.credentials.password, 'a', sizeof(model.credentials.password));
    assert(!qdd_setup_delete(&model));
    assert(!qdd_setup_append(&model, "x"));
    qdd_setup_exit(&model);
    password_is_clear(&model);

    select_network(&model, false);
    memset(ascii64, 'b', 63);
    ascii64[63] = 0;
    assert(qdd_setup_append(&model, ascii64));
    (void)key(&model, QDD_SETUP_OK);
    (void)key(&model, QDD_SETUP_OK);
    assert(strlen(model.credentials.password) == 64);
    (void)key(&model, QDD_SETUP_OK);
    (void)key(&model, QDD_SETUP_OK);
    assert(strlen(model.credentials.password) == 64);
    assert(!model.choosing_column && strcmp(model.error, "密码最多64字节") == 0);
}

static void test_ssid_validation(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false);
    assert(qdd_setup_append(&model, "never retained"));
    assert(!qdd_setup_select(&model, "\xe2\x82", false));
    assert(model.page == QDD_SETUP_ERROR && model.credentials.ssid[0] == 0);
    password_is_clear(&model);
    assert(strcmp(model.error, "网络名称无效") == 0);
    (void)key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_LIST);
    assert(!qdd_setup_select(&model, NULL, false));
    assert(!qdd_setup_select(&model, "", false));
    assert(!qdd_setup_select(&model, "012345678901234567890123456789012", false));
    assert(qdd_setup_select(&model, "01234567890123456789012345678901", false));
    assert(strlen(model.credentials.ssid) == 32);
    assert(qdd_setup_select(&model, "中文中文中文中文中文ab", false));
    assert(strlen(model.credentials.ssid) == 32);
    assert(!qdd_setup_select(&model, "中文中文中文中文中文中", false));
    assert(!qdd_setup_select(&model, "0123456789012345678901234567890\xe2", false));
    assert(qdd_setup_select(&model, "中文😀 Wi-Fi", false));
    assert(qdd_setup_select(&model, model.credentials.ssid, true));
    assert(strcmp(model.credentials.ssid, "中文😀 Wi-Fi") == 0);
    assert(model.open && model.page == QDD_SETUP_ACTIONS);
}

static qdd_setup_action_t connect(qdd_setup_model_t *model) {
    if (model->page == QDD_SETUP_PASSWORD) (void)key(model, QDD_SETUP_LONG_OK);
    assert(model->page == QDD_SETUP_ACTIONS && model->action_index == 0);
    return key(model, QDD_SETUP_OK);
}

static void test_save_validation(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false);
    assert(connect(&model) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_ACTIONS && strcmp(model.error, "密码至少8字节") == 0);
    assert(qdd_setup_append(&model, "1234567"));
    assert(connect(&model) == QDD_SETUP_NONE);
    assert(qdd_setup_append(&model, "8"));
    assert(connect(&model) == QDD_SETUP_SAVE);
    assert(model.page == QDD_SETUP_CONNECTING && model.error == NULL);
    assert(key(&model, QDD_SETUP_UP) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_CONNECTING);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_LIST);
    password_is_clear(&model);

    select_network(&model, true);
    assert(connect(&model) == QDD_SETUP_SAVE);
    assert(model.page == QDD_SETUP_CONNECTING);
    select_network(&model, false);
    char password[65];
    memset(password, 'z', 63);
    password[63] = 0;
    assert(qdd_setup_append(&model, password));
    assert(connect(&model) == QDD_SETUP_SAVE);
    select_network(&model, false);
    password[63] = 'z';
    password[64] = 0;
    assert(qdd_setup_append(&model, password));
    assert(connect(&model) == QDD_SETUP_NONE);
    assert(strcmp(model.error, "64字节密码须为十六进制") == 0);
    select_network(&model, false);
    for (unsigned i = 0; i < 64; i++) password[i] = "0123456789aAbBcCdDeEfF"[i % 22];
    assert(qdd_setup_append(&model, password));
    assert(connect(&model) == QDD_SETUP_SAVE);

    select_network(&model, false);
    assert(qdd_setup_append(&model, "中国abc")); // Nine UTF-8 bytes, not five characters.
    assert(connect(&model) == QDD_SETUP_SAVE);
}

static void test_back_error_and_wiping(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false);
    assert(qdd_setup_append(&model, "test password"));
    (void)key(&model, QDD_SETUP_LONG_OK);
    (void)key(&model, QDD_SETUP_UP);
    assert(model.action_index == 4);
    (void)key(&model, QDD_SETUP_DOWN);
    assert(model.action_index == 0);
    (void)key(&model, QDD_SETUP_UP);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_LIST);
    password_is_clear(&model);

    assert(qdd_setup_select(&model, "Test network", false));
    assert(qdd_setup_append(&model, "test password"));
    qdd_setup_error(&model, "连接失败，请重试");
    assert(model.page == QDD_SETUP_ERROR && model.error != NULL);
    (void)key(&model, QDD_SETUP_OK);
    assert(model.page == QDD_SETUP_PASSWORD && model.error == NULL);
    assert(strcmp(model.credentials.password, "test password") == 0);
    qdd_setup_error(&model, NULL);
    assert(strcmp(model.error, "连接失败，请重试") == 0);
    (void)key(&model, QDD_SETUP_LONG_OK);
    assert(model.page == QDD_SETUP_LIST);
    password_is_clear(&model);
    assert(qdd_setup_select(&model, "Test network", false));
    assert(qdd_setup_append(&model, "test password"));
    (void)key(&model, QDD_SETUP_LONG_OK);
    (void)key(&model, QDD_SETUP_LONG_OK);
    assert(model.page == QDD_SETUP_LIST);
    password_is_clear(&model);
    assert(qdd_setup_select(&model, "Test network", false));
    assert(qdd_setup_append(&model, "test password"));
    assert(qdd_setup_enter(&model) == QDD_SETUP_SCAN);
    password_is_clear(&model);
    assert(model.credentials.ssid[0] == 0);
    assert(qdd_setup_append(&model, "test password"));
    qdd_setup_exit(&model);
    password_is_clear(&model);
    assert(model.page == QDD_SETUP_HOME && model.credentials.ssid[0] == 0);
}

static void test_reset_requires_explicit_local_confirmation(void) {
    qdd_setup_model_t model = {0};
    select_network(&model, false); assert(qdd_setup_append(&model, "staged secret"));
    qdd_setup_menu(&model); password_is_clear(&model);
    for (unsigned i = 0; i < 3; i++) assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE);
    assert(model.selection == 3);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_RESET && model.selection == 0);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_MENU && model.selection == 3);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE && model.selection == 1);
    assert(key(&model, QDD_SETUP_LONG_OK) == QDD_SETUP_NONE); // A hold never clears data.
    assert(model.page == QDD_SETUP_MENU && model.selection == 3);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(key(&model, QDD_SETUP_UP) == QDD_SETUP_NONE && model.selection == 1);
    assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE && model.selection == 0);
    assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE && model.selection == 1);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_RESET_DEVICE);
    assert(model.page == QDD_SETUP_RESET); // The worker, not the model, owns erasure/reboot.
    password_is_clear(&model);
}

static void test_all_sixty_four_networks_and_actions_are_reachable(void) {
    qdd_setup_model_t model = {0}; qdd_setup_enter(&model);
    for (unsigned i = 0; i < 64; i++) {
        assert(model.selection == i);
        assert(qdd_setup_key(&model, QDD_SETUP_OK, 64, false) == QDD_SETUP_SELECT);
        assert(qdd_setup_key(&model, QDD_SETUP_DOWN, 64, false) == QDD_SETUP_NONE);
    }
    assert(model.selection == 64);
    assert(qdd_setup_key(&model, QDD_SETUP_DOWN, 64, false) == QDD_SETUP_NONE && model.selection == 65);
    assert(qdd_setup_key(&model, QDD_SETUP_UP, 64, false) == QDD_SETUP_NONE && model.selection == 64);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 64, false) == QDD_SETUP_SCAN && model.selection == 0);
    assert(qdd_setup_key(&model, QDD_SETUP_UP, 64, false) == QDD_SETUP_NONE && model.selection == 65);
    assert(qdd_setup_key(&model, QDD_SETUP_OK, 64, false) == QDD_SETUP_NONE && model.page == QDD_SETUP_MENU);
}

static void test_clear_entire_password_returns_to_keyboard(void) {
    qdd_setup_model_t model = {0}; select_network(&model, false);
    assert(qdd_setup_append(&model, "中国abc"));
    model.credentials.password[60] = '!'; // Stale bytes after NUL must also be erased.
    model.row = 7; model.column = 2; model.choosing_column = true;
    assert(key(&model, QDD_SETUP_LONG_OK) == QDD_SETUP_NONE);
    for (unsigned i = 0; i < 3; i++) assert(key(&model, QDD_SETUP_DOWN) == QDD_SETUP_NONE);
    assert(model.action_index == 3);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE);
    assert(model.page == QDD_SETUP_PASSWORD && !model.choosing_column && model.error == NULL);
    assert(model.row == 7 && model.column == 2);
    assert(strcmp(model.credentials.ssid, "Test network") == 0);
    password_is_clear(&model);
    assert(qdd_setup_append(&model, "again")); // Ready to enter a replacement immediately.
    assert(key(&model, QDD_SETUP_LONG_OK) == QDD_SETUP_NONE);
    for (unsigned i = 0; i < 3; i++) key(&model, QDD_SETUP_DOWN);
    key(&model, QDD_SETUP_OK); password_is_clear(&model);
    assert(key(&model, QDD_SETUP_LONG_OK) == QDD_SETUP_NONE);
    for (unsigned i = 0; i < 3; i++) key(&model, QDD_SETUP_DOWN);
    assert(key(&model, QDD_SETUP_OK) == QDD_SETUP_NONE); // Clearing an empty password is safe.
    password_is_clear(&model);
    assert(model.page == QDD_SETUP_PASSWORD);
    assert(qdd_setup_append(&model, "中国a"));
    key(&model, QDD_SETUP_LONG_OK); key(&model, QDD_SETUP_DOWN); key(&model, QDD_SETUP_DOWN);
    assert(model.action_index == 2); key(&model, QDD_SETUP_OK);
    assert(strcmp(model.credentials.password, "中国") == 0); // Single-character delete is retained.
}

int main(void) {
    test_settings_download_is_display_only();
    test_list();
    test_all_sixty_four_networks_and_actions_are_reachable();
    test_short_press_menu_navigation();
    test_first_connection_intro();
    test_reset_requires_explicit_local_confirmation();
    test_keyboard_reachability();
    test_focus_and_last_row();
    test_utf8_and_limits();
    test_ssid_validation();
    test_save_validation();
    test_back_error_and_wiping();
    test_clear_entire_password_returns_to_keyboard();
    puts("QDD native Wi-Fi setup ASCII reachability, focus, UTF-8 bounds, validation and secret-wipe tests: PASS");
    return 0;
}
