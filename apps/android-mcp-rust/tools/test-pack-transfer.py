#!/usr/bin/env python3
"""Adversarial ZIP audit tests; fixture executables are never run."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile
import zlib

SPEC = importlib.util.spec_from_file_location("pack_transfer", Path(__file__).with_name("pack-transfer.py"))
PACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACK)
NAME = "设备操作台.exe"
EXE = b"EXE audit fixture - never executed"


def archive(contents=EXE, *, name=NAME, method=8, flags=0x800, external=0,
            claimed_size=None, claimed_crc=None, compressed_tail=b"", truncate=0):
    raw_name = name.encode("utf-8")
    compressor = zlib.compressobj(wbits=-15)
    segment = compressor.compress(contents) + compressor.flush() if method == 8 else contents
    segment = segment[:-truncate] if truncate else segment
    segment += compressed_tail
    size = len(contents) if claimed_size is None else claimed_size
    crc = zlib.crc32(contents) if claimed_crc is None else claimed_crc
    local = struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, flags, method, 0, 0,
                        crc, len(segment), size, len(raw_name), 0) + raw_name + segment
    central = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, flags, method, 0, 0,
                          crc, len(segment), size, len(raw_name), 0, 0, 0, 0, external, 0) + raw_name
    return local + central + struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, 1, 1,
                                         len(central), len(local), 0)


class ZipAuditTests(unittest.TestCase):
    def test_source_archive_preserves_operator_regression_fixtures(self):
        entries = PACK.source_entries()
        names = {"apps/android-mcp-rust/tools/fixtures/" + filename for filename in
                 ("operator-text-cases.js", "operator-recovery-cases.js")}
        for name in names:
            self.assertTrue(name in entries, "Source archive omitted an operator regression fixture")
            expected = (PACK.REPO / name).read_bytes()
            self.assertEqual(entries[name], expected)
            with zipfile.ZipFile(io.BytesIO(PACK.deterministic_zip(entries))) as archive:
                self.assertEqual(archive.read(name), expected)
        self.assertEqual({entry for entry in entries
                          if entry.startswith("apps/android-mcp-rust/tools/") and entry.endswith(".js")}, names)

    def test_source_allowlist_includes_only_native_helper_sources(self):
        entries = PACK.source_entries()
        prefix = "apps/android-mcp-rust/tools/usb-driver/"
        expected = {prefix + name for name in (
            "windows.c", "protocol.c", "protocol.h", "transfer.c", "transfer.h", "hardware.c", "hardware.h",
            "test-protocol.c", "test-transfer.c", "test-hardware.c", "README.md", "build.mjs",
        )}
        self.assertEqual({name for name in entries if name.startswith(prefix)}, expected)
        self.assertFalse(any(name.endswith((".exe", ".exe.gz", "qdd-android.json", ".log")) for name in entries))

    def verify(self, packed, accepted):
        directory = Path(tempfile.mkdtemp(prefix="qdd-zip-audit-test-")).resolve()
        self.assertEqual(directory.parent, Path(tempfile.gettempdir()).resolve())
        paths = [directory / NAME, directory / "设备操作台.zip"]
        manifest = {"executable": NAME, "bytes": len(EXE), "sha256": PACK.sha(EXE),
                    "zipBytes": len(packed), "zipSha256": PACK.sha(packed), "buildId": "fixture"}
        try:
            paths[0].write_bytes(EXE)
            paths[1].write_bytes(packed)
            result = types.SimpleNamespace(returncode=0, stdout=json.dumps({"status": "ok", "buildId": "fixture"}).encode())
            with patch.object(PACK.subprocess, "run", return_value=result) as process:
                if accepted:
                    report = PACK.verify_executable_zip(directory, manifest)
                    self.assertEqual(report["extractedSha256"], manifest["sha256"])
                    process.assert_called_once()
                else:
                    with self.assertRaises((RuntimeError, zipfile.BadZipFile, zlib.error)):
                        PACK.verify_executable_zip(directory, manifest)
                    process.assert_not_called()
        finally:
            for path in paths:
                path.unlink(missing_ok=True)
            directory.rmdir()

    def test_exact_stored_and_deflate(self):
        for method in (0, 8):
            with self.subTest(method=method):
                self.verify(archive(method=method), True)

    def test_size_and_crc_cannot_hide_deflate_output(self):
        packed = archive(EXE + b"hidden" * 20000, claimed_size=len(EXE), claimed_crc=zlib.crc32(EXE))
        # Python's normal reader incorrectly treats this as the exact EXE.
        with zipfile.ZipFile(io.BytesIO(packed)) as zipped:
            self.assertIsNone(zipped.testzip())
            self.assertEqual(zipped.read(NAME), EXE)
        self.verify(packed, False)

    def test_compressed_stream_must_be_complete_without_tail(self):
        for packed in (archive(compressed_tail=b"hidden"), archive(truncate=1),
                       archive(EXE + b"hidden", method=0, claimed_size=len(EXE), claimed_crc=zlib.crc32(EXE))):
            with self.subTest(packed=PACK.sha(packed)):
                self.verify(packed, False)

    def test_local_header_must_match_central_header(self):
        for offset, value, width in ((6, 0x808, 2), (8, 0, 2), (14, 0, 4), (18, 1, 4), (22, 1, 4)):
            packed = bytearray(archive())
            struct.pack_into("<H" if width == 2 else "<I", packed, offset, value)
            with self.subTest(localOffset=offset):
                self.verify(bytes(packed), False)
        packed = bytearray(archive())
        packed[30] ^= 1
        self.verify(bytes(packed), False)

    def test_complete_name_encryption_and_links(self):
        for packed in (archive(name=NAME + "\0../other.exe"), archive(flags=0x801),
                       archive(external=0o120777 << 16)):
            with self.subTest(packed=PACK.sha(packed)):
                self.verify(packed, False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
