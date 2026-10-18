#!/usr/bin/env python3
"""Execute actual main text functions with bounded hardware mocks and check GATT integration."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[1]
def function(source: str, name: str) -> str:
    match = re.search(rf"(?m)^(?:static\s+)?(?:void|bool|qdd_ble_text_send_t)\s+{name}\s*\([^;]*?\)\s*\{{", source)
    if not match:
        raise AssertionError(f"missing production function {name}")
    depth = 1
    for i in range(match.end(), len(source)):
        depth += (source[i] == "{") - (source[i] == "}")
        if not depth:
            return source[match.start():i + 1]
    raise AssertionError(f"unterminated function {name}")
class TextIntegration(unittest.TestCase):
    def test_actual_main_routing_and_indication_pump(self):
        source = (ROOT / "main/qdd_main.c").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="qdd-text-host-") as temporary:
            directory = Path(temporary)
            (directory / "qdd_text_main_extract.h").write_text(function(source,"text_fast_allowed") + "\n" + function(source,"sync_text") + "\n" + function(source,"on_text_line"),encoding="utf-8")
            executable = directory / ("test.exe" if os.name == "nt" else "test")
            subprocess.run([os.environ.get("CC","cc"),"-std=c11","-Wall","-Wextra","-Werror",
                "-I"+str(ROOT/"main"),"-I"+str(ROOT/"tests/qdd_wifi_host"),"-I"+str(directory),
                str(ROOT/"tests/test_qdd_text_main.c"),str(ROOT/"main/qdd_text.c"),str(ROOT/"main/qdd_hid.c"),
                str(ROOT/"main/qdd_control.c"),"-o",str(executable)],check=True)
            subprocess.run([str(executable)],check=True)
    def test_actual_ble_public_queue_and_service_changed_slot(self):
        source = (ROOT/"main/qdd_ble.c").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="qdd-text-ble-") as temporary:
            directory = Path(temporary)
            bodies = [function(source,name) for name in ("text_send_failed","text_send_event","qdd_ble_text_cancel_pending","qdd_ble_text_indicate")]
            (directory/"qdd_text_ble_extract.h").write_text("\n".join(bodies),encoding="utf-8")
            start = source.index("    case BLE_GAP_EVENT_NOTIFY_TX: {")
            end = source.index("    case BLE_GAP_EVENT_DISCONNECT:",start)
            branch = source[start:end].replace("    case BLE_GAP_EVENT_NOTIFY_TX: ","",1)
            (directory/"qdd_text_ble_notify_extract.h").write_text("static int production_notify(struct mock_event *event) " + branch,encoding="utf-8")
            executable=directory/("test.exe" if os.name=="nt" else "test")
            subprocess.run([os.environ.get("CC","cc"),"-std=c11","-Wall","-Wextra","-Werror",
                "-I"+str(ROOT/"main"),"-I"+str(ROOT/"tests/qdd_wifi_host"),"-I"+str(directory),
                str(ROOT/"tests/test_qdd_text_ble.c"),"-o",str(executable)],check=True)
            subprocess.run([str(executable)],check=True)
    def test_gatt_security_append_order_and_confirmation(self):
        source = (ROOT/"main/qdd_ble.c").read_text(encoding="utf-8")
        self.assertLess(source.index("0x180A"),source.index(".uuid = &s_text_service.u"))
        self.assertRegex(source,r"s_text_indication.u[^}]+BLE_GATT_CHR_F_INDICATE[^}]+BLE_GATT_CHR_F_NOTIFY_INDICATE_ENC[^}]+min_key_size = 16")
        self.assertRegex(source,r"s_text_write.u[^}]+BLE_GATT_CHR_F_WRITE_ENC[^}]+min_key_size = 16")
        self.assertNotIn("BLE_GATT_CHR_F_WRITE_AUTHEN",source)
        self.assertIn("ble_svc_gatt_changed(1, 0xffff)",source)
        self.assertIn("s_att_indication_busy = event->notify_tx.status != BLE_HS_EDONE",source)
        self.assertIn("event->notify_tx.status == BLE_HS_EDONE",source)
        self.assertIn("event->notify_tx.conn_handle != atomic_load(&s_connection)",source)
        self.assertEqual(source.count("ble_hs_mbuf_from_flat(bytes, length)"),1)
        self.assertNotIn("ble_store_util_delete",source)
        self.assertNotIn("nvs_flash_erase",source)
    def test_route_and_build_are_integrated(self):
        main = (ROOT/"main/qdd_main.c").read_text(encoding="utf-8")
        self.assertIn('strncmp(line, "QDDTXT/1 ", 9)',main)
        self.assertIn("sync_text();",function(main,"sync_safety"))
        self.assertIn('"qdd_text.c"',(ROOT/"main/CMakeLists.txt").read_text(encoding="utf-8"))
        header = (ROOT/"main/qdd_hid.h").read_text(encoding="utf-8")
        self.assertIn("#define QDD_LINE_MAX 128",header)
        self.assertIn("#define QDD_HEARTBEAT_MS 1500",header)
if __name__ == "__main__": unittest.main()
