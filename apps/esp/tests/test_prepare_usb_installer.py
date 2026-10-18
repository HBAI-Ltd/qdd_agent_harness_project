import gzip
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from prepare_usb_installer import prepare, SOURCE_FILES


class UsbInstallerTests(unittest.TestCase):
    def fixture(self, folder, data=None):
        root = Path(folder)
        self.manifest, self.exe = root / "manifest.json", root / "installer.exe"
        self.output, self.header = root / "out/installer.gz", root / "out/installer.h"
        self.sources = root / "sources"
        inputs = []
        for name in sorted(SOURCE_FILES):
            source = self.sources / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"fixture source\n")
            inputs.append({"path": name, "bytes": 15, "sha256": hashlib.sha256(b"fixture source\n").hexdigest()})
        if data is None:
            data = bytearray(1024)
            data[:2] = b"MZ"
            struct.pack_into("<I", data, 0x3c, 64)
            data[64:68] = b"PE\0\0"
            struct.pack_into("<H", data, 68, 0x8664)
        self.exe.write_bytes(data)
        self.value = {"platform": "win32-x64", "protocol": "QDDDRV/1",
                      "executable": self.exe.name, "bytes": len(data),
                      "sha256": hashlib.sha256(data).hexdigest(), "sourceInputs": inputs}
        self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
        return bytes(data)

    def run_prepare(self):
        return prepare(self.manifest, self.exe, self.output, self.header, self.sources)

    def test_exact_manifest_gzip_and_generated_header(self):
        with tempfile.TemporaryDirectory() as folder:
            data = self.fixture(folder)
            first = self.run_prepare()
            self.assertEqual(gzip.decompress(self.output.read_bytes()), data)
            self.assertIn(first["sourceSha256"], self.header.read_text(encoding="utf-8"))
            self.assertIn(f" {len(data)}u", self.header.read_text(encoding="utf-8"))
            self.assertEqual(self.output.read_bytes()[4:8], bytes(4))
            self.assertEqual(first, self.run_prepare())

    def test_drift_platform_protocol_size_and_hash_fail_before_writing(self):
        for key, bad in (("platform", "win32-arm64"), ("protocol", "QDDHID/1"),
                         ("bytes", 1025), ("bytes", True), ("sha256", "0" * 64),
                         ("executable", "different.exe")):
            with self.subTest(key=key, bad=bad), tempfile.TemporaryDirectory() as folder:
                self.fixture(folder)
                self.value[key] = bad
                self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())
                self.assertFalse(self.header.exists())

    def test_pe_bounds_and_input_preservation(self):
        for size in (0, 63, 128 * 1024 + 1):
            with self.subTest(size=size), tempfile.TemporaryDirectory() as folder:
                self.fixture(folder, b"x" * size)
                with self.assertRaises(ValueError):
                    self.run_prepare()
        with tempfile.TemporaryDirectory() as folder:
            data = self.fixture(folder)
            for offset, replacement in ((0, b"ZZ"), (64, b"NE\0\0"), (68, b"\x4c\x01"),
                                        (60, b"\xff\xff\xff\xff")):
                damaged = bytearray(data)
                damaged[offset:offset + len(replacement)] = replacement
                self.fixture(folder, damaged)
                with self.assertRaises(ValueError):
                    self.run_prepare()
            self.fixture(folder)
            with self.assertRaises(ValueError):
                prepare(self.manifest, self.exe, self.exe, self.header, self.sources)
            self.assertEqual(self.exe.read_bytes(), data)

    def test_source_drift_and_untrusted_manifest_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            (self.sources / "tools/usb-driver/windows.c").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "source changed"):
                self.run_prepare()
            self.assertFalse(self.output.exists())
            self.fixture(folder)
            self.value["sourceInputs"][0]["path"] = "../../private.env"
            self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "incomplete"):
                self.run_prepare()
            self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
