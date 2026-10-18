import hashlib
import io
from pathlib import Path
import struct
import sys
import unittest
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import pack_download_assets as pack
from verify_firmware import ENTRY


def table(entries=None):
    entries = entries or [(1, 2, 0x9000, 0x6000, "nvs"),
                          (0, 0x10, 0x20000, 0x2F0000, "ota_0"),
                          (1, 0x82, 0x600000, 0x200000, "assets")]
    raw = b"".join(ENTRY.pack(0x50AA, kind, sub, offset, size, name.encode(), 0)
                   for kind, sub, offset, size, name in entries)
    raw += b"\xeb\xeb" + b"\xff" * 14 + hashlib.md5(raw).digest()
    return raw + b"\xff" * (4096 - len(raw))


def executable(size=9000):
    raw = bytearray(size)
    raw[:2] = b"MZ"
    struct.pack_into("<I", raw, 0x3C, 64)
    raw[64:70] = b"PE\0\0\x64\x86"
    return bytes(raw)


def manifest(exe):
    return {"runtime": "rust", "platform": "win32-x64", "buildId": "fixture",
            "bytes": len(exe), "sha256": hashlib.sha256(exe).hexdigest()}


def archive(exe, names=None, *, mode=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for name in names or [pack.ZIP_EXECUTABLE]:
            if mode is None:
                zipped.writestr(name, exe)
            else:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = mode << 16
                zipped.writestr(entry, exe)
    return output.getvalue()


def zipped_manifest(exe, payload):
    return {**manifest(exe), "executable": pack.ZIP_EXECUTABLE,
            "zipBytes": len(payload), "zipSha256": hashlib.sha256(payload).hexdigest()}


def rewrite_zip_headers(payload, field_offset, value, width=2):
    raw = bytearray(payload)
    local = raw.index(b"PK\x03\x04")
    central = raw.index(b"PK\x01\x02")
    # Local flags/method/CRC/length offsets are two bytes before central ones.
    for location, offset in ((local, field_offset), (central, field_offset + 2)):
        raw[location + offset:location + offset + width] = value.to_bytes(width, "little")
    return bytes(raw)


class DriverAssetsTests(unittest.TestCase):
    def test_zip_round_trip_keeps_archive_and_exe_identities_separate(self):
        exe = executable(18000)
        payload = archive(exe)
        build = zipped_manifest(exe, payload)
        image, report = pack.create_image(payload, table(), build, payload_kind="zip")
        self.assertEqual(image[:8], b"QDDDRV2\0")
        self.assertEqual(image[4096:], payload)
        self.assertEqual((report["version"], report["payloadKind"], report["payloadBytes"]), (2, "zip", len(payload)))
        self.assertEqual(report["payloadSha256"], build["zipSha256"])
        self.assertEqual((report["exeBytes"], report["exeSha256"]), (len(exe), build["sha256"]))
        self.assertEqual(pack.verify_image(image, table(), build), report)
        self.assertEqual(report["writeOffset"], 0x600000)
        self.assertLessEqual(report["eraseEndExclusive"], 0x800000)
        self.assertFalse(report["eraseAll"])

    def test_zip_entry_and_executable_rejections(self):
        exe = executable()
        bad_archives = [archive(exe, ["wrong.exe"]), archive(exe, ["../" + pack.ZIP_EXECUTABLE]),
                        archive(exe, [pack.ZIP_EXECUTABLE, "config.json"]),
                        archive(exe, mode=0o120777), archive(b"bad PE")]
        for payload in bad_archives:
            with self.subTest(payload=len(payload)), self.assertRaises(ValueError):
                pack.create_image(payload, table(), zipped_manifest(exe, payload), payload_kind="zip")
        payload = archive(exe)
        build = zipped_manifest(exe, payload)
        for field, value in (("zipBytes", len(payload) - 1), ("zipSha256", "0" * 64),
                             ("sha256", "0" * 64), ("bytes", len(exe) - 1),
                             ("bytes", pack.MAX_UNCOMPRESSED_BYTES + 1), ("bytes", True),
                             ("executable", "other.exe")):
            wrong = {**build, field: value}
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                pack.create_image(payload, table(), wrong, payload_kind="zip")

    def test_zip_crc_encryption_utf8_and_size_bomb_rejections(self):
        exe = executable()
        payload = archive(exe)
        bad_archives = [payload[:-22],
                        rewrite_zip_headers(payload, 6, 0x801),  # encrypted
                        rewrite_zip_headers(payload, 6, 0),  # Chinese name requires UTF-8
                        rewrite_zip_headers(payload, 14, 0, 4),  # wrong CRC
                        rewrite_zip_headers(payload, 22, pack.MAX_UNCOMPRESSED_BYTES + 1, 4)]
        for broken in bad_archives:
            with self.subTest(length=len(broken)), self.assertRaises(ValueError):
                pack.create_image(broken, table(), zipped_manifest(exe, broken), payload_kind="zip")
        wrong_pe = bytearray(exe); wrong_pe[68] = 0
        broken = archive(wrong_pe)
        with self.assertRaises(ValueError):
            pack.create_image(broken, table(), zipped_manifest(wrong_pe, broken), payload_kind="zip")

    def test_payload_type_confusion_and_zip_image_corruption(self):
        exe = executable()
        payload = archive(exe)
        build = zipped_manifest(exe, payload)
        with self.assertRaises(ValueError):
            pack.create_image(payload, table(), build)  # ZIP is never an EXE.
        with self.assertRaises(ValueError):
            pack.create_image(exe, table(), build, payload_kind="zip")
        image, _ = pack.create_image(payload, table(), build, payload_kind="zip")
        for offset in (0, 8, 12, 16, 20, 24, 56, 63, 64, 4095, 4100):
            broken = bytearray(image); broken[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                pack.verify_image(broken, table(), build)

    def test_zip_central_length_cannot_hide_deflate_tail(self):
        exe = executable()
        # ZipExtFile clips its output to central file_size. A fake length/CRC
        # can make a larger DEFLATE stream appear to be this exact EXE prefix.
        payload = archive(exe + b"hidden" * 20000)
        payload = rewrite_zip_headers(payload, 22, len(exe), 4)
        payload = rewrite_zip_headers(payload, 14, zlib.crc32(exe), 4)
        with self.assertRaises(ValueError):
            pack.create_image(payload, table(), zipped_manifest(exe, payload), payload_kind="zip")

    def test_zip_complete_filename_cannot_hide_null_suffix(self):
        exe = executable()
        payload = bytearray(archive(exe))
        extra = b"\0../other.exe"
        central = payload.index(b"PK\x01\x02")
        end = payload.index(b"PK\x05\x06")
        name_size = len(pack.ZIP_EXECUTABLE.encode("utf-8"))
        central_size = struct.unpack_from("<I", payload, end + 12)[0]
        struct.pack_into("<H", payload, 26, name_size + len(extra))
        struct.pack_into("<H", payload, central + 28, name_size + len(extra))
        payload[central + 46 + name_size:central + 46 + name_size] = extra
        payload[30 + name_size:30 + name_size] = extra
        struct.pack_into("<I", payload, end + 2 * len(extra) + 12, central_size + len(extra))
        struct.pack_into("<I", payload, end + 2 * len(extra) + 16, central + len(extra))
        with self.assertRaises(ValueError):
            pack.create_image(payload, table(), zipped_manifest(exe, payload), payload_kind="zip")

    def test_round_trip_boundaries_and_identity(self):
        exe = executable()
        image, report = pack.create_image(exe, table(), manifest(exe))
        self.assertEqual(image[4096:], exe)
        self.assertEqual(report["writeOffset"], 0x600000)
        self.assertEqual(report["eraseEndExclusive"], 0x604000)
        self.assertFalse(report["eraseAll"])
        self.assertEqual(pack.verify_image(image, table(), manifest(exe)), report)

    def test_exact_fit_and_oversized(self):
        exe = executable(0x200000 - 4096)
        _, report = pack.create_image(exe, table(), manifest(exe))
        self.assertEqual(report["remainingBytes"], 0)
        with self.assertRaises(ValueError):
            pack.create_image(exe + b"0", table(), manifest(exe + b"0"))

    def test_missing_assets_invalid_md5_overlap_alignment(self):
        invalid = [table([(0, 0, 0x10000, 0x7F0000, "factory")]),
                   table([(0, 0, 0x10000, 0x7F0000, "factory"), (1, 0x82, 0x600000, 0x200000, "assets")]),
                   table([(1, 0x82, 0x600001, 0x1FF000, "assets")])]
        corrupted = bytearray(table()); corrupted[40] ^= 1; invalid.append(corrupted)
        for raw in invalid:
            with self.assertRaises(ValueError):
                pack.assets_partition(raw)

    def test_corrupt_header_length_padding_payload_and_manifest(self):
        exe = executable()
        image, _ = pack.create_image(exe, table(), manifest(exe))
        for offset in (0, 8, 12, 16, 20, 24, 56, 63, 64, 4095, 4200):
            broken = bytearray(image); broken[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                pack.verify_image(broken, table(), manifest(exe))
        for broken in (image[:-1], image + b"0"):
            with self.assertRaises(ValueError):
                pack.verify_image(broken, table(), manifest(exe))
        wrong = manifest(exe); wrong["runtime"] = "node"
        with self.assertRaises(ValueError):
            pack.verify_image(image, table(), wrong)

    def test_wrong_machine_or_invalid_pe(self):
        exe = bytearray(executable()); exe[68] = 0
        with self.assertRaises(ValueError):
            pack.create_image(exe, table(), manifest(exe))
        exe[0] = 0
        with self.assertRaises(ValueError):
            pack.create_image(exe, table(), manifest(exe))


if __name__ == "__main__":
    unittest.main()
