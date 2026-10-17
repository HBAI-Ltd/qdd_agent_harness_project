"""Audit the application wiring around host-tested transport state machines."""
from pathlib import Path
import re
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TransportContractTest(unittest.TestCase):
    def setUp(self):
        self.main = (ROOT / "main/qdd_main.c").read_text(encoding="utf8")

    def test_expired_tcp_owner_is_closed_after_pause(self):
        sync = self.main.split("static void sync_safety(void)", 1)[1].split("static bool write_reply", 1)[0]
        self.assertRegex(sync, re.compile(r"previous_owner = s_control.owner;.*?qdd_control_tick.*?qdd_hid_pause\(&s_state, false\);\s*s_state.heartbeat_seen = false;\s*if \(previous_owner == QDD_SOURCE_TCP\) qdd_wifi_close_client\(\);", re.S))

    def test_new_tcp_epoch_drops_owner_and_partial_line(self):
        loop = self.main.split("for (;;) {", 2)[2]
        self.assertRegex(loop, re.compile(r"s_tcp_epoch != qdd_wifi_tcp_epoch\(\).*?drop_controller\(QDD_SOURCE_TCP\);\s*memset\(&s_tcp_stream, 0, sizeof\(s_tcp_stream\)\)", re.S))
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
        self.assertIn("atomic_load(&s_home_selection) == 1", callback)
        sync = self.main.split("static void sync_safety(void)", 1)[1].split("static bool write_reply", 1)[0]
        unlock = sync.split("if ((events & EVENT_UNLOCK)", 1)[1]
        self.assertIn("!(events & (EVENT_STOP | EVENT_MENU))", unlock)
        self.assertIn("qdd_hid_unlock(&s_state)", unlock)
        self.assertNotIn("qdd_hid_execute", unlock)
        self.assertNotIn(".op = QDD_ARM", unlock)

    def test_actual_callback_uses_current_selection_and_never_navigates_into_stop(self):
        callback = "static void on_key(" + self.main.split("static void on_key(", 1)[1].split("static bool report(", 1)[0]
        definitions = "\n".join(re.findall(r"^#define EVENT_[^\n]+", self.main, re.M))
        source = r"""
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
typedef enum { BSP_BTN_UP, BSP_BTN_DOWN, BSP_BTN_OK } bsp_btn_t;
typedef enum { BSP_BTN_PRESS, BSP_BTN_CLICK, BSP_BTN_LONG } bsp_btn_ev_t;
static atomic_uint s_events, s_home_selection;
static atomic_bool s_physical_stop, s_configuring;
""" + definitions + "\n" + callback + r"""
static void reset(void) {
  atomic_store(&s_events, 0); atomic_store(&s_home_selection, 0);
  atomic_store(&s_physical_stop, false); atomic_store(&s_configuring, false);
}
int main(void) {
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
  return 0;
}
"""
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "buttons.c"
            executable = Path(directory) / ("buttons.exe" if os.name == "nt" else "buttons")
            source_path.write_text(source, encoding="utf8")
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", str(source_path), "-o", str(executable)], check=True, capture_output=True)
            subprocess.run([str(executable)], check=True, capture_output=True)

    def test_ui_does_not_expose_a_manual_pause_or_resume_workflow(self):
        for filename in ("qdd_ui.c", "qdd_ui_model.c"):
            ui = (ROOT / "main" / filename).read_text(encoding="utf8")
            self.assertNotIn("暂停", ui)
            self.assertNotIn("恢复", ui)
            self.assertNotIn("QDD_UI_PAUSED", ui)

    def test_menus_use_navigation_only_behind_the_input_gate(self):
        callback = self.main.split("static void on_key(", 1)[1].split("static bool report(", 1)[0]
        stop = callback.split("} else {", 1)[1]
        self.assertLess(stop.index("atomic_store(&s_physical_stop, true)"), stop.index("atomic_fetch_or(&s_events, EVENT_STOP)"))
        configuring = callback.split("return;", 1)[0]
        self.assertIn("EVENT_CONFIG_DOWN", configuring)
        self.assertNotIn("EVENT_STOP", configuring)
        self.assertNotIn("qdd_ui_", callback)
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

    def test_download_guide_keeps_browser_download_and_same_lan_instructions(self):
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        qr = ui.split("if (view->show_qr) {", 1)[1].split("} else {", 1)[0]
        self.assertIn('"扫码或浏览器打开地址下载"', qr)
        self.assertIn('"手机/电脑/ESP同一局域网"', qr)
        self.assertIn('"%s:3334"', qr)

    def test_product_titles_are_generic_and_pairing_identifiers_are_unchanged(self):
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        model = (ROOT / "main/qdd_ui_model.c").read_text(encoding="utf8")
        landing = (ROOT / "main/qdd_onboarding.c").read_text(encoding="utf8")
        self.assertIn('"设备控制器"', ui)
        self.assertNotIn('"QDD"', ui)
        self.assertNotIn("安卓", ui + model + landing)
        self.assertIn("下载设备投屏", landing)
        self.assertIn("设备操作台", landing + model)
        self.assertIn("qdd_ble_name()", ui)


if __name__ == "__main__":
    unittest.main()
