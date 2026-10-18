import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from prepare_desktop_zip import prepare, MAX_ZIP_BYTES
from test_pack_download_assets import executable, archive, zipped_manifest


class EmbeddedDesktopTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder)
        self.manifest = root / "manifest.json"
        self.archive = root / "desktop.zip"
        self.output = root / "out/qdd_desktop.zip"
        self.header = root / "out/qdd_desktop_zip.h"
        self.exe = executable()
        self.payload = archive(self.exe)
        self.value = zipped_manifest(self.exe, self.payload)
        self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
        self.archive.write_bytes(self.payload)

    def run_prepare(self):
        return prepare(self.manifest, self.archive, self.output, self.header)

    def test_exact_zip_and_contained_exe_identity_with_no_partition_dependency(self):
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            first = self.run_prepare()
            self.assertEqual(self.output.read_bytes(), self.payload)
            self.assertEqual(first["sourceSha256"], self.value["zipSha256"])
            self.assertEqual(first["exeSha256"], self.value["sha256"])
            self.assertEqual(first["fallback"], "only-when-assets-partition-is-absent")
            self.assertIn(first["sourceSha256"], self.header.read_text(encoding="utf-8"))
            self.assertIn(f" {len(self.payload)}u", self.header.read_text(encoding="utf-8"))
            self.assertEqual(first, self.run_prepare())

    def test_manifest_and_size_drift_fail_before_outputs(self):
        for key, bad in (("runtime", "node"), ("platform", "win32-arm64"),
                         ("buildId", ""), ("zipBytes", True),
                         ("zipBytes", MAX_ZIP_BYTES + 1), ("zipBytes", 63),
                         ("zipSha256", "0" * 64), ("sha256", "0" * 64),
                         ("executable", "other.exe"), ("bytes", 9010)):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                self.fixture(folder)
                self.value[key] = bad
                self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())
                self.assertFalse(self.header.exists())

    def test_payload_crc_content_and_structure_must_match(self):
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            damaged = bytearray(self.payload)
            damaged[60] ^= 1
            cases = [bytes(damaged), self.payload[:-22],
                     archive(self.exe, ["../设备操作台.exe"]),
                     archive(self.exe, ["设备操作台.exe", "settings.json"]),
                     archive(b"not an executable")]
            for payload in cases:
                with self.subTest(size=len(payload)):
                    self.archive.write_bytes(payload)
                    self.value["zipBytes"] = len(payload)
                    self.value["zipSha256"] = hashlib.sha256(payload).hexdigest()
                    self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        self.run_prepare()
                    self.assertFalse(self.output.exists())

    def test_outputs_cannot_overwrite_inputs_or_each_other(self):
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            for output, header in ((self.archive, self.header), (self.output, self.manifest),
                                   (self.output, self.output)):
                with self.subTest(output=output, header=header), self.assertRaises(ValueError):
                    prepare(self.manifest, self.archive, output, header)
            self.assertEqual(self.archive.read_bytes(), self.payload)


if __name__ == "__main__":
    unittest.main()
