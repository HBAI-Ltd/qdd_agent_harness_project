#include "bsp_battery.h"
#include "bsp_button.h"
#include "bsp_display.h"
#include "bsp_i2c.h"
#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "qdd_ble.h"
#include "qdd_hid.h"
#include "qdd_ui.h"
#include "qdd_ui_model.h"
#include "qdd_control.h"
#include "qdd_net_config.h"
#include "qdd_setup_model.h"
#include "qdd_wifi.h"
#include "qdd_onboarding.h"
#include "qdd_reset.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#define EVENT_STOP 1u
#define EVENT_UNLOCK 4u
#define EVENT_MENU 8u
#define EVENT_CONFIG_UP 32u
#define EVENT_CONFIG_DOWN 64u
#define EVENT_CONFIG_OK 128u
#define EVENT_CONFIG_LONG 256u
#define EVENT_SKIP_APP 512u
#define EVENT_SKIP_BLUETOOTH 1024u
#define SKIP_APP 1u
#define SKIP_BLUETOOTH 2u

static atomic_uint s_events;
static atomic_bool s_buttons_ready;
static atomic_bool s_physical_stop;
static atomic_bool s_configuring;
static atomic_uint s_home_selection;
static atomic_uint s_onboarding_skips;
static qdd_hid_state_t s_state;
static qdd_stream_t s_usb_stream, s_tcp_stream;
static qdd_control_t s_control;
static qdd_usb_presence_t s_usb_presence;
static qdd_setup_model_t s_setup;
static qdd_wifi_credentials_t s_pending_wifi;
static bool s_pending_ssid, s_pending_password, s_was_scanning;
static uint32_t s_tcp_epoch;
static uint32_t s_link_epoch;
static const char *s_message = "";
static uint64_t s_message_ms;
static portMUX_TYPE s_view_lock = portMUX_INITIALIZER_UNLOCKED;
static qdd_hid_state_t s_view_state;
static const char *s_view_message = "";
static uint64_t s_view_message_ms;
static qdd_setup_model_t s_view_setup;
static bool s_view_control_live;
static bool controller_live(void);

static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000u; }

static bool usb_live(void) {
  return qdd_control_usb_live(&s_usb_presence, usb_serial_jtag_is_connected(), now_ms());
}

static void ui_feedback(const char *message) {
  s_message = message;
  s_message_ms = now_ms();
}

static void on_key(bsp_btn_t button, bsp_btn_ev_t event, void *context) {
  (void)context;
  // esp_timer callback: bounded atomic operations only, never BLE/LVGL/I/O.
  if (!atomic_load(&s_buttons_ready)) return;
  if (atomic_load(&s_configuring)) {
    if (event == BSP_BTN_PRESS && button == BSP_BTN_UP) atomic_fetch_or(&s_events, EVENT_CONFIG_UP);
    else if (event == BSP_BTN_PRESS && button == BSP_BTN_DOWN) atomic_fetch_or(&s_events, EVENT_CONFIG_DOWN);
    else if (event == BSP_BTN_CLICK && button == BSP_BTN_OK) atomic_fetch_or(&s_events, EVENT_CONFIG_OK);
    else if (event == BSP_BTN_LONG && button == BSP_BTN_OK) atomic_fetch_or(&s_events, EVENT_CONFIG_LONG);
    return;
  }
  if (event == BSP_BTN_PRESS && (button == BSP_BTN_UP || button == BSP_BTN_DOWN)) {
    // Two vertical choices: update synchronously so a rapid navigation + OK
    // sequence never acts on a worker's older selection snapshot.
    if (qdd_ui_home_choices(qdd_ui_guide_step()) > 1) atomic_fetch_xor(&s_home_selection, 1u);
  } else if (button == BSP_BTN_OK && event == BSP_BTN_CLICK) {
    const qdd_ui_home_action_t action = qdd_ui_home_action(qdd_ui_guide_step(),
        atomic_load(&s_home_selection), atomic_load(&s_physical_stop));
    if (action == QDD_UI_HOME_SETTINGS) {
      atomic_store(&s_configuring, true);
      atomic_fetch_or(&s_events, EVENT_MENU);
    } else if (action == QDD_UI_HOME_SKIP_APP || action == QDD_UI_HOME_SKIP_BLUETOOTH) {
      atomic_fetch_or(&s_events, action == QDD_UI_HOME_SKIP_APP ? EVENT_SKIP_APP : EVENT_SKIP_BLUETOOTH);
    } else if (action == QDD_UI_HOME_UNLOCK) {
      atomic_fetch_or(&s_events, EVENT_UNLOCK);
    } else {
      atomic_store(&s_physical_stop, true);
      atomic_fetch_or(&s_events, EVENT_STOP);
    }
  }
}

static bool report(uint8_t id, const uint8_t *data, size_t length, void *context) {
  bool nonzero = false;
  for (size_t i = 0; i < length; i++) nonzero |= data[i] != 0;
  // Confirming emergency stop takes effect before the worker consumes its event; no queued long
  // gestures or delayed keyboard sequences can outlive the physical latch.
  if (nonzero && (!controller_live() || atomic_load(&s_physical_stop) || atomic_load(&s_configuring) ||
      (atomic_load(&s_events) & (EVENT_STOP | EVENT_MENU)))) return false;
  return qdd_ble_report(id, data, length, context);
}

static bool controller_live(void) {
  return s_control.owner == QDD_SOURCE_USB ? usb_live() :
    s_control.owner == QDD_SOURCE_TCP ? qdd_wifi_tcp_live() : false;
}

static void drop_controller(qdd_source_t source) {
  if (!qdd_control_drop(&s_control, source)) return;
  qdd_hid_pause(&s_state, false);
  s_state.heartbeat_seen = false;
}

static void setup_action(qdd_setup_action_t action) {
  if (action == QDD_SETUP_RESET_DEVICE) {
    atomic_store(&s_onboarding_skips, 0);
    // Settings already blocks nonzero reports. Release before committing the
    // local-only reset request; no live BLE/Wi-Fi task ever erases storage.
    atomic_store(&s_physical_stop, true);
    qdd_hid_pause(&s_state, true);
    (void)qdd_hid_release(&s_state, report, NULL);
    qdd_wifi_allow_reconnect(false);
    qdd_wifi_close_client();
    if (qdd_reset_request() != ESP_OK) {
      s_setup.error = "重置失败，请重试";
      s_setup.selection = 0;
      return;
    }
    esp_restart();
  } else if (action == QDD_SETUP_PAIR_PHONE) {
    qdd_ble_open_pairing();
    ui_feedback("PAIRING");
  } else if (action == QDD_SETUP_SCAN) {
    atomic_store(&s_onboarding_skips, 0);
    if (qdd_wifi_scan() != ESP_OK) qdd_setup_error(&s_setup, "暂时找不到网络，请重试");
  } else if (action == QDD_SETUP_SELECT) {
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    qdd_wifi_ap_t ap;
    if (qdd_wifi_ap(s_setup.selection, wifi.scan_revision, &ap)) {
      qdd_setup_select(&s_setup, ap.ssid, ap.open);
    }
  } else if (action == QDD_SETUP_SAVE) {
    atomic_store(&s_onboarding_skips, 0);
    if (qdd_wifi_save(&s_setup.credentials) != ESP_OK) qdd_setup_error(&s_setup, "连接失败，请检查密码");
  } else if (action == QDD_SETUP_EXIT) {
    // Exiting never clears the physical stop latch or authorizes input.
    qdd_hid_pause(&s_state, false);
    qdd_wifi_allow_reconnect(true);
    atomic_store(&s_home_selection, 0);
    atomic_store(&s_configuring, false);
    ui_feedback("");
  }
}

static void setup_key(qdd_setup_key_t key) {
  const qdd_wifi_view_t wifi = qdd_wifi_view();
  setup_action(qdd_setup_key(&s_setup, key, wifi.count, wifi.scanning));
}

static void sync_safety(void) {
  qdd_ble_pairing_context(atomic_load(&s_configuring) ?
      s_setup.page == QDD_SETUP_PAIR : qdd_ui_guide_step() == 4);
  qdd_ble_poll();
  const qdd_ble_status_t ble = qdd_ble_status();
  if (s_link_epoch != ble.link_epoch) {
    qdd_hid_pause(&s_state, false);
    s_link_epoch = ble.link_epoch;
  }
  qdd_hid_set_link(&s_state, ble.connected, ble.encrypted, ble.authenticated, ble.bonded);
  qdd_hid_set_ready(&s_state, ble.ready, ble.consumer_ready);
  const qdd_source_t previous_owner = s_control.owner;
  if (qdd_control_tick(&s_control, usb_live(), qdd_wifi_tcp_live(), now_ms())) {
    qdd_hid_pause(&s_state, false);
    s_state.heartbeat_seen = false;
    if (previous_owner == QDD_SOURCE_TCP) qdd_wifi_close_client();
  }
  qdd_hid_tick(&s_state, now_ms(), controller_live());
  const unsigned events = atomic_exchange(&s_events, 0);
  if (events & (EVENT_SKIP_APP | EVENT_SKIP_BLUETOOTH)) {
    unsigned skipped = 0;
    if (events & EVENT_SKIP_APP) skipped |= SKIP_APP;
    if (events & EVENT_SKIP_BLUETOOTH) skipped |= SKIP_BLUETOOTH;
    atomic_fetch_or(&s_onboarding_skips, skipped);
    atomic_store(&s_home_selection, 0);
  }
  if ((events & EVENT_STOP) || atomic_load(&s_physical_stop)) {
    if (!s_state.locked || s_state.armed) qdd_hid_pause(&s_state, true);
    if (events & EVENT_STOP) ui_feedback("PHYSICAL_STOP");
  }
  if (events & EVENT_MENU) {
    qdd_hid_pause(&s_state, false);
    qdd_wifi_allow_reconnect(false);
    qdd_setup_menu(&s_setup);
  }
  if (atomic_load(&s_configuring)) {
    if (s_state.armed) qdd_hid_pause(&s_state, false);
    if (events & EVENT_CONFIG_UP) setup_key(QDD_SETUP_UP);
    if (events & EVENT_CONFIG_DOWN) setup_key(QDD_SETUP_DOWN);
    if (events & EVENT_CONFIG_OK) setup_key(QDD_SETUP_OK);
    if (events & EVENT_CONFIG_LONG) setup_key(QDD_SETUP_LONG_OK);
  }
  // STOP wins if two events were observed together. Unlock requires a later OK.
  if ((events & EVENT_UNLOCK) && !atomic_load(&s_configuring) && !(events & (EVENT_STOP | EVENT_MENU))) {
    atomic_store(&s_physical_stop, false);
    qdd_hid_unlock(&s_state);
    ui_feedback("UNLOCKED");
  }
  if (s_state.release_required) (void)qdd_hid_release(&s_state, report, NULL);
}

static bool write_reply(qdd_source_t source, const char *reply) {
  const size_t length = strlen(reply);
  const bool written = source == QDD_SOURCE_TCP ? qdd_wifi_write(reply, length) :
    usb_serial_jtag_write_bytes(reply, length, pdMS_TO_TICKS(10)) == (int)length;
  if (!written && s_control.owner == source) {
    drop_controller(source);
    (void)qdd_hid_release(&s_state, report, NULL);
    ui_feedback("USB_REPLY_FAILED");
  }
  return written;
}

static void on_net_line(const char *line, qdd_source_t source) {
  qdd_net_command_t command = {0};
  const char *error = qdd_net_parse(line, &command) ? NULL : "BAD_COMMAND";
  if (!error && source != QDD_SOURCE_USB) error = "USB_ONLY";
  if (!error && command.operation != QDD_NET_STATUS && command.operation != QDD_NET_DIAGNOSTICS) {
    if (!qdd_control_usb_config(&s_control, s_state.armed)) error = "CONTROL_BUSY";
    else if (atomic_load(&s_configuring)) error = "CONFIGURING";
    else {
      esp_err_t result = ESP_OK;
      switch (command.operation) {
        case QDD_NET_SSID:
          memset(&s_pending_wifi, 0, sizeof(s_pending_wifi));
          memcpy(s_pending_wifi.ssid, command.data, command.length);
          s_pending_ssid = true;
          s_pending_password = false;
          break;
        case QDD_NET_PASSWORD:
          if (!s_pending_ssid) { error = "SSID_REQUIRED"; break; }
          memset(s_pending_wifi.password, 0, sizeof(s_pending_wifi.password));
          memcpy(s_pending_wifi.password, command.data, command.length);
          s_pending_password = true;
          break;
        case QDD_NET_SAVE:
          if (!s_pending_ssid || !s_pending_password || !qdd_wifi_credentials_valid(&s_pending_wifi)) error = "INVALID_WIFI";
          else result = qdd_wifi_save(&s_pending_wifi);
          memset(&s_pending_wifi, 0, sizeof(s_pending_wifi));
          s_pending_ssid = s_pending_password = false;
          break;
        case QDD_NET_CLEAR: result = qdd_wifi_clear(); break;
        case QDD_NET_RETRY: result = qdd_wifi_retry(); break;
        default: break;
      }
      if (result != ESP_OK) error = "WIFI_FAILED";
    }
  }
  if (!error && command.operation == QDD_NET_DIAGNOSTICS) {
    // Only this main worker uses the diagnostic reply. Keep the larger JSON
    // off its stack and separate from HTTP/UDP buffers and control replies.
    static char diagnostic[512];
    const int prefix = snprintf(diagnostic, sizeof(diagnostic), "QDDNET/1 %lu OK ", (unsigned long)command.id);
    const size_t size = prefix > 0 && (size_t)prefix < sizeof(diagnostic) - 2 ?
        qdd_wifi_diagnostics(diagnostic + prefix, sizeof(diagnostic) - (size_t)prefix - 2) : 0;
    if (size) {
      diagnostic[(size_t)prefix + size] = '\n';
      diagnostic[(size_t)prefix + size + 1] = 0;
      memset(&command, 0, sizeof(command));
      (void)write_reply(source, diagnostic);
      return;
    }
    error = "WIFI_FAILED";
  }
  const qdd_wifi_view_t wifi = qdd_wifi_view();
  char reply[QDD_REPLY_MAX];
  if (error) snprintf(reply, sizeof(reply), "QDDNET/1 %lu ERR %s\n", (unsigned long)command.id, error);
  else snprintf(reply, sizeof(reply), "QDDNET/1 %lu OK {\"configured\":%s,\"connected\":%s,\"ip\":\"%s\",\"port\":%u}\n",
    (unsigned long)command.id, wifi.configured ? "true" : "false", wifi.connected ? "true" : "false", wifi.ip, wifi.port);
  memset(&command, 0, sizeof(command));
  (void)write_reply(source, reply);
}

static void on_line(const char *line, const char *error, void *context) {
  const qdd_source_t source = (qdd_source_t)(uintptr_t)context;
  qdd_command_t command = {0};
  sync_safety();
  if (!error && strncmp(line, "QDDNET/1 ", 9) == 0) { on_net_line(line, source); return; }
  if (!error && !qdd_parse_command(line, &command)) error = "BAD_COMMAND";
  if (!error && atomic_load(&s_configuring) && command.op != QDD_STATUS &&
      command.op != QDD_PAIR_STATUS && command.op != QDD_PAUSE && command.op != QDD_RELEASE &&
      !(command.op == QDD_PING && s_control.owner == source)) error = "CONFIGURING";
  if (!error) error = qdd_control_allow(&s_control, source, command.op, now_ms());
  if (!error) error = qdd_hid_execute(&s_state, &command, now_ms(), report, NULL);
  if (!error && command.op == QDD_PAIR) {
    qdd_ble_open_pairing();
    ui_feedback("PAIRING");
  }
  sync_safety();
  if (!error && command.op == QDD_ARM && s_state.armed && !s_state.locked) ui_feedback("ENABLED");
  char reply[QDD_REPLY_MAX];
  if (command.op == QDD_PAIR || command.op == QDD_PAIR_STATUS) {
    const qdd_ble_status_t ble = qdd_ble_status();
    qdd_format_pairing_reply(reply, sizeof(reply), command.id, error, &s_state,
                             qdd_ble_name(), ble.pairing_open, ble.passkey_visible, ble.passkey);
  } else {
    qdd_format_reply(reply, sizeof(reply), command.id, error, &s_state, qdd_ble_name());
  }
  if (write_reply(source, reply) && error && s_control.owner == source) ui_feedback(error);
}

static void display_task(void *context) {
  (void)context;
  uint64_t last_battery = 0;
  bool battery_read = false;
  int battery = -1;
  for (;;) {
    const uint64_t now = now_ms();
    // Battery I2C can wait 100 ms on failure. It must never delay releases or
    // heartbeat processing, so it runs in this separate presentation task.
    if (!battery_read || now - last_battery >= 5000) {
      battery = bsp_battery_soc();
      qdd_ble_set_battery(battery);
      last_battery = now;
      battery_read = true;
    }
    portENTER_CRITICAL(&s_view_lock);
    const qdd_hid_state_t state = s_view_state;
    const char *message = s_view_message;
    const uint64_t message_ms = s_view_message_ms;
    const bool control_live = s_view_control_live;
    const qdd_setup_model_t setup = s_view_setup;
    portEXIT_CRITICAL(&s_view_lock);
    if (bsp_lvgl_lock(10)) {
      const unsigned skipped = atomic_load(&s_onboarding_skips);
      qdd_ui_onboarding_skips((skipped & SKIP_APP) != 0, (skipped & SKIP_BLUETOOTH) != 0);
      qdd_ui_home_selection(atomic_load(&s_home_selection));
      qdd_ui_wifi(&setup, qdd_wifi_view());
      qdd_ui_refresh(&state, qdd_ble_status(), control_live, battery, now_ms(), message, message_ms);
      bsp_lvgl_unlock();
    }
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

void app_main(void) {
  // This is the application's only startup path. The BSP demo menu is not linked.
  bool reset_applied = false;
  const esp_err_t storage_error = qdd_reset_boot(&reset_applied);
  esp_err_t error = bsp_i2c_init();
  if (error != ESP_OK || bsp_display_init() != ESP_OK || !bsp_lvgl_init()) {
    ESP_LOGE("qdd", "Display initialization failed; bridge remains disabled");
    return;
  }
  if (!bsp_lvgl_lock(1000)) return;
  qdd_ui_create();
  qdd_ui_require_onboarding(reset_applied);
  bsp_lvgl_unlock();
  bsp_display_backlight(80);
  (void)bsp_battery_init();
  error = storage_error == ESP_OK ? bsp_button_init(on_key, NULL) : storage_error;
  if (error == ESP_OK) error = qdd_ble_start();
  usb_serial_jtag_driver_config_t serial = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
  serial.tx_buffer_size = 1024;
  serial.rx_buffer_size = 512;
  if (error == ESP_OK) error = usb_serial_jtag_driver_install(&serial);
  if (error != ESP_OK) {
    atomic_store(&s_physical_stop, true);
    qdd_hid_pause(&s_state, true);
    if (bsp_lvgl_lock(1000)) {
      const uint64_t failed_ms = now_ms();
      qdd_ui_refresh(&s_state, qdd_ble_status(), false, -1, failed_ms, "STARTUP_FAILED", failed_ms);
      bsp_lvgl_unlock();
    }
    ESP_LOGE("qdd", "Bridge initialization failed: %s", esp_err_to_name(error));
    return;
  }
  // stdout and the protocol share USB CDC. Keep boot diagnostics, then avoid
  // asynchronous ESP-IDF logs interleaving with a request's single reply line.
  esp_log_level_set("*", ESP_LOG_NONE);
  if (qdd_wifi_start() != ESP_OK) ui_feedback("WIFI_FAILED");
  if (qdd_onboarding_start() != ESP_OK) ui_feedback("STARTUP_FAILED");
  if (!qdd_wifi_view().configured) {
    qdd_ui_require_onboarding(true);
    qdd_setup_intro(&s_setup);
    atomic_store(&s_configuring, true);
    // Publish the guide before the presentation worker's first snapshot.
    // Confirming it returns to step one without scanning or changing NVS.
    s_view_setup = s_setup;
    if (!bsp_lvgl_lock(1000)) return;
    qdd_ui_wifi(&s_setup, qdd_wifi_view());
    bsp_lvgl_unlock();
  }
  if (xTaskCreate(display_task, "qdd_ui", 4096, NULL, 2, NULL) != pdPASS) {
    ESP_LOGE("qdd", "Presentation task failed; bridge remains disabled");
    return;
  }
  atomic_store(&s_buttons_ready, true);
  vTaskPrioritySet(NULL, 6);
  for (;;) {
    qdd_wifi_poll(now_ms(), s_control.owner == QDD_SOURCE_TCP);
    if (s_tcp_epoch != qdd_wifi_tcp_epoch()) {
      drop_controller(QDD_SOURCE_TCP);
      memset(&s_tcp_stream, 0, sizeof(s_tcp_stream));
      s_tcp_epoch = qdd_wifi_tcp_epoch();
    }
    if (!usb_live()) {
      memset(&s_usb_stream, 0, sizeof(s_usb_stream));
      memset(&s_pending_wifi, 0, sizeof(s_pending_wifi));
      s_pending_ssid = s_pending_password = false;
    }
    const qdd_wifi_view_t wifi = qdd_wifi_view();
    if (atomic_load(&s_configuring)) {
      if (s_setup.page == QDD_SETUP_CONNECTING && wifi.connected) {
        qdd_setup_exit(&s_setup);
        setup_action(QDD_SETUP_EXIT);
        ui_feedback("WIFI_CONNECTED");
      } else if ((s_was_scanning && !wifi.scanning && wifi.failed) ||
          (s_setup.page == QDD_SETUP_CONNECTING && wifi.failed && !wifi.connecting)) {
        qdd_setup_error(&s_setup, "连接失败，请检查网络");
      }
    }
    s_was_scanning = wifi.scanning;
    sync_safety();
    uint8_t bytes[64];
    const int count = usb_serial_jtag_read_bytes(bytes, sizeof(bytes), pdMS_TO_TICKS(10));
    if (count > 0) qdd_stream_feed(&s_usb_stream, bytes, (size_t)count, on_line, (void *)(uintptr_t)QDD_SOURCE_USB);
    const int tcp_count = qdd_wifi_read(bytes, sizeof(bytes));
    if (tcp_count > 0) qdd_stream_feed(&s_tcp_stream, bytes, (size_t)tcp_count, on_line, (void *)(uintptr_t)QDD_SOURCE_TCP);
    sync_safety();
    portENTER_CRITICAL(&s_view_lock);
    s_view_state = s_state;
    s_view_message = s_message;
    s_view_message_ms = s_message_ms;
    s_view_setup = s_setup;
    s_view_control_live = controller_live();
    portEXIT_CRITICAL(&s_view_lock);
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
