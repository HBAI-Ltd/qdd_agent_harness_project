"""Audit the application wiring around host-tested transport state machines."""
from pathlib import Path
import re
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def c_block(source, marker):
    """Extract a whole current function/branch, including nested early returns."""
    start = source.index(marker)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"Unclosed C block: {marker}")


class TransportContractTest(unittest.TestCase):
    def setUp(self):
        self.main = (ROOT / "main/qdd_main.c").read_text(encoding="utf8")

    def test_application_selects_bounded_single_dma_buffer_before_radio_start(self):
        startup = c_block(self.main, "void app_main(void)")
        self.assertIn("bsp_lvgl_init_with_buffer_rows(20)", startup)
        self.assertNotIn("bsp_lvgl_init()", startup)
        self.assertLess(startup.index("bsp_lvgl_init_with_buffer_rows(20)"), startup.index("qdd_ble_start()"))

    def test_expired_tcp_owner_is_closed_after_pause(self):
        sync = self.main.split("static void sync_safety(void)", 1)[1].split("static bool write_reply", 1)[0]
        self.assertRegex(sync, re.compile(r"previous_owner = s_control.owner;.*?qdd_control_tick.*?qdd_hid_pause\(&s_state, false\);\s*s_state.heartbeat_seen = false;\s*if \(previous_owner == QDD_SOURCE_TCP\) qdd_wifi_close_client\(\);", re.S))

    def test_new_tcp_epoch_drops_owner_and_partial_line(self):
        loop = self.main.split("for (;;) {", 2)[2]
        self.assertIn("qdd_wifi_poll(now_ms(), s_control.owner == QDD_SOURCE_TCP);", loop)
        self.assertRegex(loop, re.compile(r"s_tcp_epoch != qdd_wifi_tcp_epoch\(\).*?drop_controller\(QDD_SOURCE_TCP\);\s*memset\(&s_tcp_stream, 0, sizeof\(s_tcp_stream\)\)", re.S))
        self.assertLess(loop.index("qdd_wifi_poll("), loop.index("s_tcp_epoch != qdd_wifi_tcp_epoch()"))
        self.assertLess(loop.index("memset(&s_tcp_stream"), loop.index("qdd_wifi_read("))
        self.assertLess(loop.index("qdd_wifi_read("), loop.index("qdd_stream_feed(&s_tcp_stream"))
        self.assertIn("qdd_stream_feed(&s_usb_stream", loop)
        self.assertIn("qdd_stream_feed(&s_tcp_stream", loop)

    def test_every_command_checks_source_before_hid_execution(self):
        line = self.main.split("static void on_line(", 1)[1].split("static void display_task", 1)[0]
        self.assertLess(line.index("qdd_control_allow("), line.index("qdd_hid_execute("))
        self.assertIn("s_control.owner == source", line)
        reply = self.main.split("static bool write_reply", 1)[1].split("static void on_net_line", 1)[0]
        self.assertIn("!written && s_control.owner == source", reply)

    def test_usb_sof_presence_is_debounced_at_every_runtime_use(self):
        self.assertEqual(self.main.count("usb_serial_jtag_is_connected()"), 1)
        presence = self.main.split("static bool usb_live(void) {", 1)[1].split("static void ui_feedback", 1)[0]
        self.assertIn("qdd_control_usb_live(&s_usb_presence, usb_serial_jtag_is_connected(), now_ms())", presence)
        controller = self.main.split("static bool controller_live(void) {", 1)[1].split("static void drop_controller", 1)[0]
        self.assertIn("QDD_SOURCE_USB ? usb_live()", controller)
        sync = self.main.split("static void sync_safety(void)", 1)[1].split("static bool write_reply", 1)[0]
        self.assertIn("qdd_control_tick(&s_control, usb_live(),", sync)
        loop = self.main.split("for (;;) {", 2)[2]
        self.assertIn("if (!usb_live())", loop)

    def test_c3_radio_budget_keeps_wifi_speed_code_out_of_shared_internal_ram(self):
        defaults = dict(re.findall(r"^(CONFIG_\w+)=(.+)$", (ROOT / "sdkconfig.defaults").read_text(encoding="utf8"), re.M))
        # The controller forwards small HID packets, not phone video. Restoring
        # these speed options would consume the headroom reserved for radio RX.
        for option in ("CONFIG_ESP_WIFI_IRAM_OPT", "CONFIG_ESP_WIFI_RX_IRAM_OPT"):
            self.assertEqual(defaults[option], "n")
        static_rx = int(defaults["CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM"])
        dynamic_rx = int(defaults["CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM"])
        self.assertGreaterEqual(static_rx, 2)
        self.assertLessEqual(static_rx, 4)
        self.assertGreaterEqual(dynamic_rx, static_rx)
        self.assertLessEqual(dynamic_rx, 8)
        self.assertLessEqual(int(defaults["CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM"]), 8)
        self.assertEqual(defaults["CONFIG_BT_NIMBLE_MAX_CONNECTIONS"], "1")
        self.assertEqual(defaults["CONFIG_ESP_WIFI_AMPDU_RX_ENABLED"], "n")
        self.assertEqual(defaults["CONFIG_ESP_WIFI_AMPDU_TX_ENABLED"], "n")
        initial_rto_ms = int(defaults["CONFIG_LWIP_TCP_RTO_TIME"])
        self.assertEqual(initial_rto_ms, 1000)
        # A TCP retransmission opportunity must precede the existing safety
        # deadlines; lowering transport recovery never extends either deadline.
        hid = (ROOT / "main/qdd_hid.h").read_text(encoding="utf8")
        watchdog_ms = int(re.search(r"^#define QDD_HEARTBEAT_MS (\d+)$", hid, re.M).group(1))
        self.assertEqual(watchdog_ms, 1500)
        self.assertLess(initial_rto_ms, 1200)  # PC SerialHidBridge's existing ACK deadline.
        self.assertLess(initial_rto_ms, watchdog_ms)
        fast_tick_ms = int(defaults["CONFIG_LWIP_TCP_TMR_INTERVAL"])
        self.assertEqual(fast_tick_ms, 125)
        slow_tick_ms = 2 * fast_tick_ms
        self.assertEqual(initial_rto_ms % slow_tick_ms, 0)
        # lwIP's integer variance floor is three slow ticks after zero-RTT
        # samples; the old 500ms tick produced 1500ms, outside the ACK deadline.
        self.assertLess(3 * slow_tick_ms, 1200)

    def test_configuration_and_dead_controller_block_reports(self):
        report = self.main.split("static bool report(", 1)[1].split("static bool controller_live(void) {", 1)[0]
        self.assertIn("!controller_live()", report)
        self.assertIn("atomic_load(&s_configuring)", report)
        self.assertIn("atomic_load(&s_physical_stop)", report)
        callback = self.main.split("static void on_key(", 1)[1].split("static bool report(", 1)[0]
        self.assertLess(callback.index("atomic_load(&s_configuring)"), callback.index("atomic_store(&s_physical_stop, true)"))
        setup_exit = self.main.split("action == QDD_SETUP_EXIT", 1)[1].split("static void setup_key", 1)[0]
        self.assertIn("qdd_hid_pause(&s_state, false)", setup_exit)
        self.assertNotIn("qdd_hid_unlock", setup_exit)
        self.assertNotIn("qdd_hid_execute", setup_exit)

    def test_neutral_usb_download_diagnostic_shares_bounded_snapshot(self):
        net = c_block(self.main, "static void on_net_line(")
        self.assertIn('source != QDD_SOURCE_USB', net)
        gate = net.split("command.operation != QDD_NET_STATUS", 1)[1].split("{", 1)[0]
        self.assertIn("QDD_NET_DOWNLOAD_DIAGNOSTICS", gate)
        diagnostic = c_block(net, "if (!error && (command.operation == QDD_NET_DIAGNOSTICS")
        self.assertIn("qdd_onboarding_download_diagnostics", diagnostic)
        self.assertNotIn("qdd_hid_execute", diagnostic)
        self.assertNotIn("qdd_wifi_save", diagnostic)
        self.assertIn("static char diagnostic[512]", diagnostic)
        onboarding = (ROOT / "main/qdd_onboarding.c").read_text(encoding="utf8")
        handler = c_block(onboarding, "static esp_err_t download_status_handler(")
        self.assertIn("qdd_onboarding_download_diagnostics", handler)

    def test_neutral_usb_oom_trace_is_bounded_and_linker_wrapped(self):
        net = c_block(self.main, "static void on_net_line(")
        self.assertIn("source != QDD_SOURCE_USB", net)
        gate = net.split("command.operation != QDD_NET_STATUS", 1)[1].split("{", 1)[0]
        self.assertIn("QDD_NET_OOM_TRACE", gate)
        diagnostic = c_block(net, "if (!error && (command.operation == QDD_NET_DIAGNOSTICS")
        self.assertIn("qdd_alloc_trace_diagnostics", diagnostic)
        self.assertNotIn("qdd_hid_execute", diagnostic)
        self.assertNotIn("qdd_wifi_save", diagnostic)
        trace = (ROOT / "main/qdd_alloc_trace.c").read_text(encoding="utf8")
        record = c_block(trace, "record_failure(")
        for forbidden in ("malloc(", "printf(", "vTask", "memcpy(", "strlen("):
            self.assertNotIn(forbidden, record)
        cmake = (ROOT / "main/CMakeLists.txt").read_text(encoding="utf8")
        for name in ("malloc", "calloc", "heap_caps_malloc"):
            self.assertIn("--wrap=" + name, cmake)
        self.assertIn("#define QDD_ALLOC_TRACE_MAX 128u", (ROOT / "main/qdd_alloc_trace.h").read_text())

    def test_wifi_management_does_not_echo_credentials(self):
        net = self.main.split("static void on_net_line", 1)[1].split("static void on_line", 1)[0]
        self.assertIn("source != QDD_SOURCE_USB", net)
        self.assertIn("qdd_control_usb_config(&s_control, s_state.armed)", net)
        reply = net.split("char reply[QDD_REPLY_MAX]", 1)[1]
        self.assertNotIn("password", reply)
        self.assertNotIn("ssid", reply)
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        self.assertEqual(ui.count("setup->credentials.password"), 1)
        self.assertIn("strlen(setup->credentials.password)", ui)

    def test_runtime_buttons_only_latch_stop_or_unlock_without_manual_arm(self):
        callback = self.main.split("static void on_key(", 1)[1].split("static bool report(", 1)[0]
        self.assertNotIn("EVENT_PAUSE", self.main)
        self.assertNotIn("EVENT_ARM", self.main)
        self.assertIn("atomic_fetch_xor(&s_home_selection, 1u)", callback)
        self.assertRegex(callback, re.compile(r"qdd_ui_home_action\(guide_step,\s*atomic_load\(&s_home_selection\), atomic_load\(&s_physical_stop\)\)", re.S))
        self.assertIn("action == QDD_UI_HOME_UNLOCK", callback)
        sync = self.main.split("static void sync_safety(void)", 1)[1].split("static bool write_reply", 1)[0]
        unlock = sync.split("if ((events & EVENT_UNLOCK)", 1)[1]
        self.assertIn("!(events & (EVENT_STOP | EVENT_MENU))", unlock)
        self.assertIn("qdd_hid_unlock(&s_state)", unlock)
        self.assertNotIn("qdd_hid_execute", unlock)
        self.assertNotIn(".op = QDD_ARM", unlock)

    def test_actual_callback_uses_current_selection_and_never_navigates_into_stop(self):
        callback = c_block(self.main, "static void on_key(")
        definitions = "\n".join(re.findall(r"^#define EVENT_[^\n]+", self.main, re.M))
        source = r"""
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
#include "qdd_ui_model.h"
typedef enum { BSP_BTN_UP, BSP_BTN_DOWN, BSP_BTN_OK } bsp_btn_t;
typedef enum { BSP_BTN_PRESS, BSP_BTN_CLICK, BSP_BTN_LONG } bsp_btn_ev_t;
static atomic_uint s_events, s_home_selection;
static atomic_bool s_physical_stop, s_configuring, s_buttons_ready;
static unsigned s_guide_step;
static unsigned qdd_ui_guide_step(void) { return s_guide_step; }
static void qdd_ui_guide_navigate(bool forward) { s_guide_step = qdd_ui_guide_target(s_guide_step, forward); }
""" + definitions + "\n" + callback + r"""
static void reset(void) {
  atomic_store(&s_events, 0); atomic_store(&s_home_selection, 0);
  atomic_store(&s_physical_stop, false); atomic_store(&s_configuring, false);
  atomic_store(&s_buttons_ready, true); s_guide_step = 0;
}
int main(void) {
  reset(); atomic_store(&s_buttons_ready, false);
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
  on_key(BSP_BTN_DOWN, BSP_BTN_PRESS, 0);
  assert(!atomic_load(&s_events) && !atomic_load(&s_physical_stop));
  assert(!atomic_load(&s_home_selection) && !atomic_load(&s_configuring));
  reset(); // Initial default is emergency stop, but navigation never stops.
  on_key(BSP_BTN_UP, BSP_BTN_PRESS, 0);
  assert(atomic_load(&s_home_selection) == 1 && !atomic_load(&s_events));
  on_key(BSP_BTN_UP, BSP_BTN_CLICK, 0); // Release must not navigate twice.
  assert(atomic_load(&s_home_selection) == 1);
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0); // No worker has processed navigation.
  assert(atomic_load(&s_configuring) && atomic_load(&s_events) == EVENT_MENU);
  assert(!atomic_load(&s_physical_stop));
  reset();
  for (unsigned i = 0; i < 50; i++) on_key(i % 2 ? BSP_BTN_UP : BSP_BTN_DOWN, BSP_BTN_PRESS, 0);
  assert(!atomic_load(&s_events) && !atomic_load(&s_physical_stop));
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
  assert(atomic_load(&s_physical_stop) && atomic_load(&s_events) == EVENT_STOP);
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0); // A same-round unlock cannot erase STOP.
  assert(atomic_load(&s_physical_stop));
  assert(atomic_load(&s_events) == (EVENT_STOP | EVENT_UNLOCK));
  reset(); atomic_store(&s_physical_stop, true);
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
  assert(atomic_load(&s_events) == EVENT_UNLOCK && atomic_load(&s_physical_stop));
  reset(); atomic_store(&s_physical_stop, true); atomic_store(&s_home_selection, 1);
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
  assert(atomic_load(&s_events) == EVENT_MENU && atomic_load(&s_physical_stop));
  reset(); atomic_store(&s_configuring, true);
  on_key(BSP_BTN_DOWN, BSP_BTN_PRESS, 0);
  assert(atomic_load(&s_events) == EVENT_CONFIG_DOWN && !atomic_load(&s_physical_stop));
  on_key(BSP_BTN_OK, BSP_BTN_LONG, 0);
  assert(atomic_load(&s_events) == (EVENT_CONFIG_DOWN | EVENT_CONFIG_LONG));
  reset(); on_key(BSP_BTN_OK, BSP_BTN_LONG, 0);
  assert(!atomic_load(&s_events) && !atomic_load(&s_physical_stop));
  // Direct page navigation never scans, pairs, changes evidence or stops input.
  for (unsigned step = 1; step <= 6; step++) {
    for (unsigned locked = 0; locked <= 1; locked++) {
      reset(); s_guide_step = step; atomic_store(&s_physical_stop, locked);
      on_key(BSP_BTN_DOWN, BSP_BTN_PRESS, 0);
      assert(s_guide_step == (locked ? step : step + 1));
      assert(!atomic_load(&s_events) && atomic_load(&s_physical_stop) == locked);
      assert(!atomic_load(&s_configuring) && atomic_load(&s_home_selection) == locked);
      reset(); s_guide_step = step;
      on_key(BSP_BTN_UP, BSP_BTN_PRESS, 0);
      assert(s_guide_step == (step == 1 ? 1 : step - 1) && !atomic_load(&s_events));
      on_key(BSP_BTN_UP, BSP_BTN_CLICK, 0); // Release does not navigate twice.
      assert(s_guide_step == (step == 1 ? 1 : step - 1));
      for (unsigned selection = 0; selection <= 1; selection++) {
        reset(); s_guide_step = step; atomic_store(&s_physical_stop, locked);
        atomic_store(&s_home_selection, selection);
        on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
        const unsigned expected = locked ? (selection ? EVENT_MENU : EVENT_UNLOCK) : step == 1 ? EVENT_WIFI_SETUP : step == 4 ? EVENT_GUIDE_PAIR : 0;
        assert(atomic_load(&s_events) == expected);
        assert(atomic_load(&s_physical_stop) == locked);
        assert(atomic_load(&s_configuring) == (expected == EVENT_WIFI_SETUP || expected == EVENT_MENU));
      }
      reset(); s_guide_step = step;
      on_key(BSP_BTN_OK, BSP_BTN_LONG, 0);
      assert(atomic_load(&s_configuring) && atomic_load(&s_events) == EVENT_MENU);
    }
  }
  reset(); s_guide_step = 6;
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
  on_key(BSP_BTN_OK, BSP_BTN_CLICK, 0);
  assert(s_guide_step == 7 && !atomic_load(&s_events) && !atomic_load(&s_physical_stop));
  return 0;
}
"""
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "buttons.c"
            executable = Path(directory) / ("buttons.exe" if os.name == "nt" else "buttons")
            source_path.write_text(source, encoding="utf8")
            compiled = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-I", str(ROOT / "main"), str(source_path), str(ROOT / "main/qdd_ui_model.c"), "-o", str(executable)], capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            subprocess.run([str(executable)], check=True, capture_output=True)

    def test_ui_does_not_expose_a_manual_pause_or_resume_workflow(self):
        for filename in ("qdd_ui.c", "qdd_ui_model.c"):
            ui = (ROOT / "main" / filename).read_text(encoding="utf8")
            self.assertNotIn("暂停", ui)
            self.assertNotRegex(ui, r'"恢复(?:控制|操作|远控|远程操作)?"')
            self.assertNotIn("QDD_UI_PAUSED", ui)

    def test_menus_use_navigation_only_behind_the_input_gate(self):
        callback = c_block(self.main, "static void on_key(")
        stop = c_block(callback, "} else {")
        self.assertLess(stop.index("atomic_store(&s_physical_stop, true)"), stop.index("atomic_fetch_or(&s_events, EVENT_STOP)"))
        configuring = c_block(callback, "if (atomic_load(&s_configuring))")
        self.assertIn("EVENT_CONFIG_DOWN", configuring)
        self.assertNotIn("EVENT_STOP", configuring)
        # These three model/atomic-read functions are bounded and do no rendering.
        self.assertEqual(set(re.findall(r"\b(qdd_ui_\w+)\(", callback)),
                         {"qdd_ui_home_choices", "qdd_ui_guide_step", "qdd_ui_home_action", "qdd_ui_guide_navigate"})
        self.assertNotIn("lv_", callback)
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        self.assertNotIn("电源", ui)
        self.assertIn('"返回上一级"', ui)
        self.assertIn('"紧急停止"', ui)
        self.assertIn('"取消急停"', ui)
        rail = ui.split("static void sidebar_draw(", 1)[1].split("static lv_obj_t *new_screen", 1)[0]
        self.assertNotIn("lv_draw_label", rail)
        self.assertIn("lv_color_hex(ACCENT)", rail)
        self.assertNotIn("0xFFFFFF", rail)
        self.assertIn("0xD4380D", ui)
        sync = self.main.split("static void sync_safety(void)", 1)[1].split("static bool write_reply", 1)[0]
        self.assertIn("qdd_setup_menu(&s_setup)", sync)
        exit_action = self.main.split("action == QDD_SETUP_EXIT", 1)[1].split("static void setup_key", 1)[0]
        self.assertLess(exit_action.index("atomic_store(&s_home_selection, 0)"), exit_action.index("atomic_store(&s_configuring, false)"))

    def test_guide_navigation_never_starts_scan_or_pairing(self):
        callback = c_block(self.main, "static void on_key(")
        confirm = c_block(callback, "action == QDD_UI_HOME_NEXT")
        self.assertIn("qdd_ui_guide_navigate(true)", confirm)
        self.assertNotIn("EVENT_WIFI_SETUP", confirm)
        self.assertNotIn("qdd_wifi_", callback)
        self.assertNotIn("qdd_ble_", callback)
        sync = c_block(self.main, "static void sync_safety(void)")
        self.assertIn("s_guide_pair_requested", sync)
        self.assertIn("events & EVENT_GUIDE_PAIR", sync)
        self.assertIn("if (events & EVENT_WIFI_SETUP) setup_action(qdd_setup_enter(&s_setup))", sync)
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        navigate = c_block(ui, "void qdd_ui_guide_navigate(")
        self.assertNotIn("lv_", navigate)
        self.assertNotIn("s_onboarding_complete", navigate)
        self.assertNotIn("skip", navigate)
        self.assertNotIn("/usb-receiver", ui)

    def test_navigation_publish_cannot_overwrite_newer_button_selection(self):
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        self.assertNotIn("s_visible_guide_step", ui)
        refresh = c_block(ui, "void qdd_ui_refresh(")
        self.assertNotIn("atomic_store(&s_requested_guide_step", refresh)
        self.assertIn("LV_EVENT_REFR_READY", ui)
        source = r"""
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
#include "qdd_ui_model.h"
typedef struct { unsigned unused; } lv_event_t;
typedef enum { MAIN, GUIDE, SETUP } screen_kind_t;
static screen_kind_t s_kind;
static bool s_finish_after_refresh;
static atomic_uint s_requested_guide_step;
""" + c_block(ui, "unsigned qdd_ui_guide_step(") + "\n" + c_block(ui, "void qdd_ui_guide_navigate(") + "\n" + c_block(ui, "static void main_refresh_ready(") + r"""
int main(void) {
    atomic_store(&s_requested_guide_step, 2);
    const unsigned worker_snapshot = atomic_load(&s_requested_guide_step);
    qdd_ui_guide_navigate(true);
    s_kind = GUIDE; s_finish_after_refresh = false;
    main_refresh_ready(0); // Rendering an older worker snapshot cannot roll input back.
    assert(worker_snapshot == 2 && qdd_ui_guide_step() == 3);
    qdd_ui_guide_navigate(true); assert(qdd_ui_guide_step() == 4);
    atomic_store(&s_requested_guide_step, 6);
    qdd_ui_guide_navigate(true); qdd_ui_guide_navigate(true);
    assert(qdd_ui_guide_step() == 7);
    s_kind = MAIN;
    main_refresh_ready(0); assert(qdd_ui_guide_step() == 7); // MAIN not submitted yet.
    s_finish_after_refresh = true;
    qdd_ui_guide_navigate(true); assert(qdd_ui_guide_step() == 7);
    main_refresh_ready(0); assert(qdd_ui_guide_step() == 0);
    assert(atomic_load(&s_requested_guide_step) == 8);
    // A newly requested guide must survive an old pending main render commit.
    atomic_store(&s_requested_guide_step, 1); s_finish_after_refresh = true;
    main_refresh_ready(0); assert(qdd_ui_guide_step() == 1);
    return 0;
}
"""
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "navigation.c"
            executable = Path(directory) / ("navigation.exe" if os.name == "nt" else "navigation")
            source_path.write_text(source, encoding="utf8")
            compiled = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-I", str(ROOT / "main"), str(source_path), str(ROOT / "main/qdd_ui_model.c"), "-o", str(executable)], capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            subprocess.run([str(executable)], check=True, capture_output=True)

    def test_download_guide_separates_usb_installation_from_phone_apk(self):
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        self.assertNotIn("手机下载APK · 电脑下载EXE", ui)
        self.assertIn("QDD_SETUP_USB_DOWNLOAD", ui)
        self.assertIn("QDD_SETUP_DOWNLOAD", ui)
        self.assertIn("qdd_ui_driver(qdd_driver_usb_view())", self.main)

    def test_product_titles_are_generic_and_pairing_identifiers_are_unchanged(self):
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        model = (ROOT / "main/qdd_ui_model.c").read_text(encoding="utf8")
        landing = (ROOT / "main/qdd_onboarding.c").read_text(encoding="utf8")
        self.assertIn('"设备控制器"', ui)
        self.assertNotIn('"QDD"', ui)
        self.assertNotIn("安卓", ui + model + landing)
        self.assertIn("设备投屏.apk", landing)
        self.assertIn("设备操作台", landing + model)
        self.assertIn("qdd_ble_name()", ui)


if __name__ == "__main__":
    unittest.main()
