#!/usr/bin/env python3
"""Create/verify an app-independent Windows driver image for an existing assets partition.

No device access or flashing. The default partition table is never changed.
Format: 64-byte little-endian header, FF padding to 4096, raw EXE (QDDDRV1)
or original ZIP bytes (QDDDRV2). The ESP never decompresses the archive.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import stat
import struct
import sys
import zipfile
import zlib
from pathlib import Path

from verify_firmware import FLASH_SIZE, Partition, parse_partition_table

HEADER = struct.Struct("<8sIIII32s8s")
HEADER_SIZE = 4096
MAGIC = b"QDDDRV1\0"
ZIP_MAGIC = b"QDDDRV2\0"
ZIP_KIND = 1
MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024
ZIP_EXECUTABLE = "设备操作台.exe"


def assets_partition(table: bytes) -> Partition:
    parts, md5 = parse_partition_table(table)
    if not md5:
        raise ValueError("partition table must have a valid MD5 trailer")
    if len({part.label for part in parts}) != len(parts):
        raise ValueError("duplicate partition labels")
    ordered = sorted(parts, key=lambda part: part.offset)
    for part in ordered:
        alignment = 0x10000 if part.kind == 0 else 0x1000
        if part.offset % alignment or part.size % 0x1000:
            raise ValueError("unaligned partition")
    for left, right in zip(ordered, ordered[1:]):
        if left.end > right.offset:
            raise ValueError("overlapping partition table")
    matches = [part for part in parts if part.label == "assets" and part.kind == 1]
    if len(matches) != 1 or matches[0].size <= HEADER_SIZE:
        raise ValueError("existing data/assets partition is required; table will not be changed")
    return matches[0]


def validate_pe(exe: bytes) -> None:
    if len(exe) < 64 or exe[:2] != b"MZ":
        raise ValueError("driver must be a nonempty Windows executable")
    pe_offset = struct.unpack_from("<I", exe, 0x3C)[0]
    if pe_offset > len(exe) - 6 or exe[pe_offset:pe_offset + 4] != b"PE\0\0":
        raise ValueError("invalid PE header")
    if struct.unpack_from("<H", exe, pe_offset + 4)[0] != 0x8664:
        raise ValueError("Windows driver must target x64")


def validate_zip(payload: bytes, manifest: dict) -> bytes:
    size = manifest.get("bytes")
    if type(size) is not int or not 64 <= size <= MAX_UNCOMPRESSED_BYTES:
        raise ValueError("manifest EXE length exceeds the bounded ZIP extraction limit")
    if (manifest.get("executable") != ZIP_EXECUTABLE or payload[:4] != b"PK\x03\x04" or
            manifest.get("zipBytes") != len(payload) or
            manifest.get("zipSha256") != hashlib.sha256(payload).hexdigest()):
        raise ValueError("ZIP does not match its build manifest")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            entries = archive.infolist()
            if len(entries) != 1:
                raise ValueError("ZIP must contain exactly one executable")
            entry = entries[0]
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if (entry.filename != ZIP_EXECUTABLE or entry.orig_filename != ZIP_EXECUTABLE or not entry.flag_bits & 0x800 or
                    entry.flag_bits & 1 or entry.is_dir() or mode not in (0, stat.S_IFREG) or
                    entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or
                    entry.file_size != size or entry.compress_size > len(payload)):
                raise ValueError("ZIP entry name, mode, encoding or size is invalid")
            # ZipExtFile clips output to the central file_size, which could
            # hide a larger stream behind a valid EXE prefix and forged CRC.
            # Check the local header and decompress the actual stored segment
            # with a hard output cap; require a complete stream with no tail.
            offset = entry.header_offset
            if offset < 0 or offset > len(payload) - 30:
                raise ValueError("invalid ZIP local header range")
            local = struct.unpack_from("<4s5H3I2H", payload, offset)
            signature, _, flags, method, _, _, crc, compressed, unpacked, name_size, extra_size = local
            name_start = offset + 30
            data_start = name_start + name_size + extra_size
            data_end = data_start + entry.compress_size
            if (signature != b"PK\x03\x04" or flags != entry.flag_bits or method != entry.compress_type or
                    payload[name_start:name_start + name_size] != ZIP_EXECUTABLE.encode("utf-8") or
                    data_start > len(payload) or data_end > len(payload) or
                    (not flags & 8 and (crc != entry.CRC or compressed != entry.compress_size or unpacked != size))):
                raise ValueError("ZIP local entry does not match its central header")
            segment = payload[data_start:data_end]
            if method == zipfile.ZIP_STORED:
                exe = segment
            else:
                decoder = zlib.decompressobj(-15)
                exe = decoder.decompress(segment, size + 1)
                if not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
                    raise ValueError("ZIP compressed stream is incomplete, oversized or has trailing bytes")
            if len(exe) != size or zlib.crc32(exe) != entry.CRC:
                raise ValueError("ZIP extracted length or CRC mismatch")
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error) as error:
        raise ValueError(f"invalid ZIP: {error}") from error
    validate_pe(exe)
    if hashlib.sha256(exe).hexdigest() != manifest.get("sha256"):
        raise ValueError("ZIP executable does not match its build manifest")
    return exe


def verify_image(image: bytes, table: bytes, manifest: dict) -> dict:
    partition = assets_partition(table)
    if len(image) < HEADER_SIZE + 64 or len(image) > partition.size:
        raise ValueError("driver resource image does not fit the existing assets partition")
    magic, version, header_size, size, kind, digest, tail = HEADER.unpack_from(image)
    raw = magic == MAGIC and version == 1 and kind == 0
    zipped = magic == ZIP_MAGIC and version == 2 and kind == ZIP_KIND
    if (not (raw or zipped) or header_size != HEADER_SIZE or tail != bytes(8)):
        raise ValueError("invalid driver resource header")
    if image[HEADER.size:HEADER_SIZE] != b"\xff" * (HEADER_SIZE - HEADER.size):
        raise ValueError("invalid header padding")
    if size != len(image) - HEADER_SIZE:
        raise ValueError("driver payload length mismatch")
    payload = image[HEADER_SIZE:]
    sha = hashlib.sha256(payload).hexdigest()
    if digest.hex() != sha:
        raise ValueError("driver payload SHA256 mismatch")
    if manifest.get("runtime") != "rust" or manifest.get("platform") != "win32-x64":
        raise ValueError("expected a Rust Windows x64 build manifest")
    exe = validate_zip(payload, manifest) if zipped else payload
    validate_pe(exe)
    if manifest.get("bytes") != len(exe) or manifest.get("sha256") != hashlib.sha256(exe).hexdigest():
        raise ValueError("EXE does not match its build manifest")
    erase_end = (partition.offset + len(image) + 4095) // 4096 * 4096
    if erase_end > partition.end or erase_end > FLASH_SIZE:
        raise ValueError("erase range exceeds the assets partition")
    return {
        "format": "QDDDRV2" if zipped else "QDDDRV1", "version": version,
        "payloadKind": "zip" if zipped else "exe", "payloadBytes": size, "payloadSha256": sha,
        "exeBuildId": manifest.get("buildId"), "exeBytes": len(exe), "exeSha256": manifest["sha256"],
        "imageBytes": len(image), "imageSha256": hashlib.sha256(image).hexdigest(),
        "partitionTableSha256": hashlib.sha256(table).hexdigest(),
        "partition": {"label": partition.label, "type": partition.kind, "subtype": partition.subtype,
                      "offset": partition.offset, "size": partition.size},
        "writeOffset": partition.offset, "eraseEndExclusive": erase_end,
        "remainingBytes": partition.size - len(image), "eraseAll": False,
        "preserve": [part for part in ("bootloader", "partition_table", "nvs", "phy_init", "otadata", "ota_0", "ota_1")],
    }


def create_image(payload: bytes, table: bytes, manifest: dict, *, payload_kind: str = "exe") -> tuple[bytes, dict]:
    partition = assets_partition(table)
    if payload_kind not in ("exe", "zip"):
        raise ValueError("unsupported payload kind")
    if len(payload) > partition.size - HEADER_SIZE:
        raise ValueError(f"payload is {len(payload)} bytes; assets payload limit is {partition.size - HEADER_SIZE}")
    zipped = payload_kind == "zip"
    header = HEADER.pack(ZIP_MAGIC if zipped else MAGIC, 2 if zipped else 1,
                         HEADER_SIZE, len(payload), ZIP_KIND if zipped else 0,
                         hashlib.sha256(payload).digest(), bytes(8))
    image = header + b"\xff" * (HEADER_SIZE - len(header)) + payload
    return image, verify_image(image, table, manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("create", "verify"))
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--exe", type=Path)
    inputs.add_argument("--zip", type=Path, help="original single-EXE Windows ZIP; never decompressed on ESP")
    parser.add_argument("--exe-manifest", required=True, type=Path)
    parser.add_argument("--partition-table", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="standalone assets image, never merged firmware")
    args = parser.parse_args()
    try:
        table = args.partition_table.read_bytes()
        manifest = json.loads(args.exe_manifest.read_text(encoding="utf-8"))
        if args.output.suffix.lower() != ".bin":
            raise ValueError("output must be a standalone .bin resource image")
        if args.mode == "create":
            source = args.zip or args.exe
            if source is None:
                raise ValueError("create requires --exe or --zip")
            if args.exe and args.exe.name != manifest.get("executable"):
                raise ValueError("EXE filename does not match its build manifest")
            image, report = create_image(source.read_bytes(), table, manifest, payload_kind="zip" if args.zip else "exe")
            if args.output.resolve() in (source.resolve(), args.exe_manifest.resolve(), args.partition_table.resolve()):
                raise ValueError("output cannot overwrite an input")
            if args.output.with_suffix(".json").resolve() in (source.resolve(), args.exe_manifest.resolve(), args.partition_table.resolve()):
                raise ValueError("resource report cannot overwrite an input")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(image)
            # Re-read the exact saved artifact; do not certify an in-memory copy.
            report = verify_image(args.output.read_bytes(), table, manifest)
            args.output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        else:
            report = verify_image(args.output.read_bytes(), table, manifest)
        print(json.dumps({"status": "pass", **report}, indent=2))
        return 0
    except (OSError, ValueError, KeyError, struct.error) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
