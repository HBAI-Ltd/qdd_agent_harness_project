"""Main-loop admission and sole-writer contract for the offline USB worker."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DriverUsbContract(unittest.TestCase):
    def test_driver_dispatch_is_usb_only_and_precedes_control(self):
        source = (ROOT / "main/qdd_main.c").read_text(encoding="utf-8")
        dispatch = source.index('strncmp(line, "QDDDRV/1 "')
        control = source.index("qdd_control_allow(&s_control, source, command.op")
        self.assertLess(dispatch, control)
        branch = source[dispatch:source.index('strncmp(line, "QDDTXT/1 "', dispatch)]
        self.assertIn('source != QDD_SOURCE_USB) driver_error = "USB_ONLY"', branch)
        self.assertIn("qdd_driver_usb_submit(&driver)", branch)

    def test_info_reservation_blocks_new_control_and_configuration(self):
        source = (ROOT / "main/qdd_main.c").read_text(encoding="utf-8")
        self.assertIn("qdd_driver_usb_tick(usb_live(), s_state.armed || s_control.owner != QDD_SOURCE_NONE)", source)
        control = source[source.index("static void on_line("):source.index("static void display_task")]
        self.assertLess(control.index("qdd_driver_usb_reserved()"), control.index("qdd_control_allow("))
        self.assertIn("command.op != QDD_PAUSE && command.op != QDD_RELEASE", control)
        text = source[source.index("static void on_text_line"):source.index("static void on_line(")]
        self.assertLess(text.index("qdd_driver_usb_reserved()"), text.index("qdd_control_allow("))
        net = source[source.index("static void on_net_line"):source.index("static void on_text_line")]
        self.assertIn("qdd_driver_usb_reserved() || !qdd_control_usb_config", net)

    def test_only_worker_can_write_usb_after_startup(self):
        main = (ROOT / "main/qdd_main.c").read_text(encoding="utf-8")
        worker = (ROOT / "main/qdd_driver_usb.c").read_text(encoding="utf-8")
        self.assertNotIn("usb_serial_jtag_write_bytes(", main)
        self.assertIn("qdd_driver_usb_reply(reply, length)", main)
        self.assertIn("USB_TX_PORTION 256u", worker)
        self.assertIn("usb_serial_jtag_write_bytes(frame + offset, portion, pdMS_TO_TICKS(10))", worker)
        self.assertIn("USB_TX_DEADLINE_MS 2000u", worker)
        self.assertIn("qdd_driver_usb_start()", main)
        self.assertIn("qdd_driver_usb_take_reply_failure()", main)
        self.assertIn("drop_controller(QDD_SOURCE_USB)", main)
        self.assertNotIn("qdd_download_assets_open", main)
        self.assertNotIn("qdd_download_assets_read", main)


if __name__ == "__main__":
    unittest.main()
