#!/usr/bin/env python3
"""Integration contracts for failed-CONNECT routing and HOGP registration."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


def function_body(source: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}\s*\([^;]*?\)\s*\{{", source)
    if not match:
        raise AssertionError(f"function not found: {name}")
    start = match.end() - 1
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start + 1:index]
    raise AssertionError(f"unterminated function: {name}")


class QddBleContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (ROOT / "main/qdd_ble.c").read_text(encoding="utf-8")

    def test_failed_connect_returns_before_connection_lookup(self) -> None:
        body = function_body(self.source, "gap_event")
        failed = re.search(
            r"if\s*\(event->connect.status\s*!=\s*0\)\s*\{([^{}]*)\}", body
        )
        self.assertIsNotNone(failed)
        branch = failed.group(1)
        self.assertIn("on_reset(event->connect.status)", branch)
        self.assertIn("advertise()", branch)
        self.assertIn("return 0;", branch)
        self.assertNotIn("ble_gap_conn_find", branch)
        self.assertLess(failed.end(), body.index("ble_gap_conn_find("))

    def test_no_private_sdk_listener_can_be_instantiated(self) -> None:
        self.assertNotRegex(self.source, r"\besp_hidd_dev_init\s*\(")
        self.assertNotIn("ble_gap_event_listener_register(", self.source)
        self.assertNotIn("esp_hidd.h", self.source)
        self.assertIn("ble_gatts_count_cfg(s_services)", self.source)
        self.assertIn("ble_gatts_add_svcs(s_services)", self.source)
        startup = function_body(self.source, "qdd_ble_start")
        self.assertIn("ble_hs_cfg.sync_cb = on_sync", startup)
        self.assertIn("ble_hs_cfg.reset_cb = on_reset", startup)

    def test_subscriptions_are_connection_scoped_and_mode_changes_are_observed(self) -> None:
        body = function_body(self.source, "gap_event")
        self.assertIn("BLE_GAP_EVENT_SUBSCRIBE", body)
        self.assertIn("event->subscribe.cur_notify != 0", body)
        disconnect = body[body.index("case BLE_GAP_EVENT_DISCONNECT:"):]
        self.assertIn("qdd_hid_subscriptions_reset(&s_subscriptions)", disconnect)
        mode = function_body(self.source, "mode_access")
        self.assertIn("s_subscriptions.protocol_mode = value", mode)
        self.assertIn("s_status.link_epoch++", mode)
        self.assertIn("update_ready_locked()", mode)

    def test_hogp_battery_and_device_information_services_are_declared(self) -> None:
        self.assertRegex(self.source, r"BLE_GATT_SVC_TYPE_PRIMARY[^\n]*0x180F")
        self.assertRegex(self.source, r"BLE_GATT_SVC_TYPE_PRIMARY[^\n]*0x180A")
        self.assertRegex(self.source, r"0x2A19\)[^}]*battery_access[^}]*BLE_GATT_CHR_F_READ")
        self.assertRegex(self.source, r"0x2A50\)[^}]*blob_access[^}]*BLE_GATT_CHR_F_READ[^}]*s_pnp_blob")
        battery = function_body(self.source, "battery_access")
        self.assertIn("atomic_load(&s_battery)", battery)
        self.assertNotIn("bsp_battery", battery)
        self.assertNotIn("i2c", battery.lower())
        self.assertIn("qdd_ble_set_battery(battery)", (ROOT / "main/qdd_main.c").read_text(encoding="utf-8"))

    def test_identity_configuration_defaults_do_not_borrow_an_assigned_vendor(self) -> None:
        defaults = (ROOT / "sdkconfig.defaults").read_text(encoding="utf-8")
        for expected in (
            "CONFIG_QDD_HID_VENDOR_ID_SOURCE=1", "CONFIG_QDD_HID_VENDOR_ID=0xFFFF",
            "CONFIG_QDD_HID_PRODUCT_ID=0x0", "CONFIG_QDD_HID_PRODUCT_VERSION=0x0100",
        ):
            self.assertIn(expected, defaults)
        startup = function_body(self.source, "qdd_ble_start")
        self.assertIn("qdd_hid_pnp_id(s_pnp_id, CONFIG_QDD_HID_VENDOR_ID_SOURCE", startup)


if __name__ == "__main__":
    unittest.main()
