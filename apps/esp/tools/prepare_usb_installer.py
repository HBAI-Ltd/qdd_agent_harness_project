#!/usr/bin/env python3
"""Verify the native USB downloader and precompress its public HTTP payload."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct


SOURCE_FILES = {f"tools/usb-driver/{name}" for name in (
    "windows.c", "protocol.c", "protocol.h", "transfer.c", "transfer.h",
    "hardware.c", "hardware.h", "build.mjs", "test-protocol.c", "test-transfer.c",
    "test-hardware.c", "README.md")} | {"tools/inspect-pe.mjs"}


def prepare(manifest_path: Path, executable: Path, output: Path, header: Path,
            source_root: Path = None) -> dict:
    paths = [path.resolve() for path in (manifest_path, executable, output, header)]
    if len(set(paths)) != len(paths):
        raise ValueError("installer inputs and outputs must be distinct")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    inputs = manifest.get("sourceInputs")
    if (not isinstance(inputs, list) or len(inputs) != len(SOURCE_FILES) or
            any(not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in inputs) or
            {item.get("path") for item in inputs} != SOURCE_FILES):
        raise ValueError("USB installer source identity is incomplete")
    source_root = source_root or Path(__file__).resolve().parents[2] / "android-mcp-rust"
    for item in inputs:
        source = (source_root / item["path"]).read_bytes()
        if (type(item.get("bytes")) is not int or item["bytes"] != len(source) or
                item.get("sha256") != hashlib.sha256(source).hexdigest()):
            raise ValueError("USB installer source changed; rebuild the native downloader")
    data = executable.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if (manifest.get("platform") != "win32-x64" or
            manifest.get("protocol") != "QDDDRV/1" or
            manifest.get("executable") != executable.name or
            type(manifest.get("bytes")) is not int or manifest["bytes"] != len(data) or
            not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("sha256", ""))) or
            manifest["sha256"] != digest):
        raise ValueError("USB installer does not match its manifest")
    if not 64 <= len(data) <= 128 * 1024 or data[:2] != b"MZ":
        raise ValueError("USB installer must be a bounded Windows PE image")
    offset = struct.unpack_from("<I", data, 0x3c)[0]
    if (offset > len(data) - 6 or data[offset:offset + 4] != b"PE\0\0" or
            struct.unpack_from("<H", data, offset + 4)[0] != 0x8664):
        raise ValueError("USB installer must target Windows x64")
    compressed = gzip.compress(data, compresslevel=9, mtime=0)
    if gzip.decompress(compressed) != data:
        raise ValueError("USB installer gzip verification failed")
    for target in (output, header):
        target.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(compressed)
    if output.read_bytes() != compressed:
        raise ValueError("saved installer differs from prepared gzip")
    header.write_text(
        "#pragma once\n"
        f"#define QDD_USB_INSTALLER_SIZE {len(data)}u\n"
        f"#define QDD_USB_INSTALLER_SHA256 \"{digest}\"\n"
        f"#define QDD_USB_INSTALLER_GZIP_SIZE {len(compressed)}u\n",
        encoding="utf-8", newline="\n")
    return {"sourceBytes": len(data), "sourceSha256": digest,
            "gzipBytes": len(compressed), "gzipSha256": hashlib.sha256(compressed).hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("executable", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("header", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.manifest, args.executable, args.output, args.header)))
        return 0
    except (OSError, ValueError, KeyError, struct.error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
