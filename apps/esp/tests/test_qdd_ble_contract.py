#!/usr/bin/env python3
"""Integration contracts for failed-CONNECT routing and HOGP registration."""

from pathlib import Path
import os
import re
import subprocess
import tempfile
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
        self.assertIn("reset_link()", branch)
        self.assertIn("request_advertising()", branch)
        self.assertIn("return 0;", branch)
        self.assertNotIn("ble_gap_conn_find", branch)
        self.assertNotIn("on_reset", branch)
        self.assertLess(failed.end(), body.index("ble_gap_conn_find("))
        self.assertIn("s_policy.host_synced = false", function_body(self.source, "on_reset"))

    def test_gap_callbacks_defer_advertising_without_recursive_restart(self) -> None:
        gap = function_body(self.source, "gap_event")
        self.assertNotRegex(gap, r"\badvertise\s*\(")
        for event in ("BLE_GAP_EVENT_DISCONNECT", "BLE_GAP_EVENT_ADV_COMPLETE"):
            marker = f"case {event}:"
            branch = gap[gap.index(marker) + len(marker):]
            branch = branch.split("case ", 1)[0] if "case " in branch else branch
            self.assertIn("request_advertising()", branch)
        self.assertIn("request_advertising()", function_body(self.source, "on_sync"))
        poll = function_body(self.source, "qdd_ble_poll")
        self.assertIn("qdd_ble_policy_advertise_due", poll)
        self.assertIn("ble_gap_adv_active()", poll)
        self.assertIn("qdd_ble_policy_advertise_failed", poll)

    def test_pairing_policy_is_integrated_without_deleting_existing_bonds(self) -> None:
        self.assertIn('"qdd_ble_policy.h"', self.source)
        self.assertIn("qdd_ble_policy_open", function_body(self.source, "qdd_ble_open_pairing"))
        self.assertIn("qdd_ble_policy_context", function_body(self.source, "qdd_ble_pairing_context"))
        self.assertIn("qdd_ble_policy_expire", function_body(self.source, "qdd_ble_poll"))
        self.assertIn("qdd_ble_policy_secure", function_body(self.source, "update_security"))
        context = function_body(self.source, "qdd_ble_pairing_context")
        self.assertIn("s_status.passkey_visible = false", context)
        self.assertIn("closed && !secure", context)
        self.assertIn("atomic_load(&s_new_peer)", context)
        gap = function_body(self.source, "gap_event")
        repeat = gap[gap.index("case BLE_GAP_EVENT_REPEAT_PAIRING:"):]
        self.assertIn("return BLE_GAP_REPEAT_PAIRING_IGNORE;", repeat)
        for forbidden in ("ble_store_util_delete_peer", "ble_store_util_delete_all",
                          "ble_gap_unpair", "nvs_flash_erase"):
            self.assertNotRegex(self.source, rf"\b{forbidden}\s*\(")

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

    def test_just_works_keeps_encryption_and_bonding_without_forging_mitm(self) -> None:
        startup = function_body(self.source, "qdd_ble_start")
        for required in ("sm_io_cap = BLE_SM_IO_CAP_NO_IO", "sm_bonding = 1", "sm_mitm = 0", "sm_sc = 1"):
            self.assertIn(required, startup)
        self.assertIn("s_status.authenticated = desc.sec_state.authenticated", self.source)
        self.assertIn("s_status.key_size = desc.sec_state.key_size", self.source)
        self.assertNotIn("s_status.authenticated = true", self.source)
        for forbidden in ("BLE_GATT_CHR_F_READ_AUTHEN", "BLE_GATT_CHR_F_WRITE_AUTHEN",
                          "BLE_GATT_CHR_F_NOTIFY_INDICATE_AUTHEN", "BLE_ATT_F_READ_AUTHEN"):
            self.assertNotIn(forbidden, self.source)
        self.assertIn("BLE_GATT_CHR_F_NOTIFY_INDICATE_ENC", self.source)
        self.assertIn("BLE_ATT_F_READ_ENC, .min_key_size = 16", self.source)

    def test_production_pairing_security_and_primary_advertisement(self) -> None:
        signatures = {
            "update_ready_locked": "static void update_ready_locked(void)",
            "qdd_ble_status": "qdd_ble_status_t qdd_ble_status(void)",
            "qdd_ble_pairing_context": "void qdd_ble_pairing_context(bool active)",
            "advertise": "static int advertise(void)",
            "update_security": "static void update_security(uint16_t connection)",
            "qdd_ble_report": "bool qdd_ble_report(uint8_t report_id, const uint8_t *data, size_t length, void *context)",
            "text_little": "static uint64_t text_little(const uint8_t *bytes, unsigned count)",
            "text_access": "static int text_access(uint16_t connection, uint16_t handle, struct ble_gatt_access_ctxt *context, void *argument)",
        }
        bodies = [signature + " {\n" + function_body(self.source, name) + "\n}"
                  for name, signature in signatures.items()]
        gap = function_body(self.source, "gap_event")
        for name, marker, end_marker in (
                ("production_connect", "CONNECT", "ENC_CHANGE"),
                ("production_encryption", "ENC_CHANGE", "PASSKEY_ACTION"),
                ("production_passkey", "PASSKEY_ACTION", "REPEAT_PAIRING")):
            start = gap.index(f"case BLE_GAP_EVENT_{marker}:") + len(f"case BLE_GAP_EVENT_{marker}:")
            end = gap.index(f"case BLE_GAP_EVENT_{end_marker}:", start)
            branch = gap[start:end].strip()
            bodies.append(f"static int {name}(struct mock_event *event) {{\n{branch}\n}}")
        with tempfile.TemporaryDirectory(prefix="qdd-ble-pairing-") as temporary:
            directory = Path(temporary)
            (directory / "qdd_ble_pairing_extract.h").write_text("\n".join(bodies), encoding="utf-8")
            executable = directory / ("test.exe" if os.name == "nt" else "test")
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-I" + str(ROOT / "main"), "-I" + str(ROOT / "tests/qdd_wifi_host"), "-I" + str(directory),
                str(ROOT / "tests/test_qdd_ble_pairing.c"), str(ROOT / "main/qdd_hid.c"),
                "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
