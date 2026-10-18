#!/usr/bin/env python3
"""Verify a Windows ZIP for immutable Flash embedding on boards without assets."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct

from pack_download_assets import validate_zip

MAX_ZIP_BYTES = 1024 * 1024


def prepare(manifest_path: Path, archive_path: Path, output: Path, header: Path) -> dict:
    paths = [path.resolve() for path in (manifest_path, archive_path, output, header)]
    if len(set(paths)) != len(paths):
        raise ValueError("desktop ZIP inputs and outputs must be distinct")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (not isinstance(manifest, dict) or manifest.get("runtime") != "rust" or
            manifest.get("platform") != "win32-x64" or
            not isinstance(manifest.get("buildId"), str) or not manifest["buildId"] or
            type(manifest.get("zipBytes")) is not int or
            not 64 <= manifest["zipBytes"] <= MAX_ZIP_BYTES or
            archive_path.stat().st_size != manifest["zipBytes"] or
            not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("zipSha256", ""))) or
            not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("sha256", "")))):
        raise ValueError("expected a bounded Rust Windows x64 ZIP manifest")
    payload = archive_path.read_bytes()
    executable = validate_zip(payload, manifest)
    digest = hashlib.sha256(payload).digest()
    generated_header = (
        "#pragma once\n"
        f"#define QDD_DESKTOP_ZIP_SIZE {len(payload)}u\n"
        f"#define QDD_DESKTOP_ZIP_SHA256 \"{digest.hex()}\"\n"
        "#define QDD_DESKTOP_ZIP_SHA256_BYTES {" +
        ", ".join(f"0x{byte:02x}" for byte in digest) + "}\n")
    for target in (output, header):
        target.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    if output.read_bytes() != payload:
        raise ValueError("saved desktop ZIP differs from verified input")
    header.write_text(generated_header, encoding="utf-8", newline="\n")
    return {"sourceBytes": len(payload), "sourceSha256": digest.hex(),
            "exeBuildId": manifest["buildId"], "exeBytes": len(executable),
            "exeSha256": hashlib.sha256(executable).hexdigest(),
            "fallback": "only-when-assets-partition-is-absent"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("manifest", "archive", "output", "header"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.manifest, args.archive, args.output, args.header)))
        return 0
    except (OSError, ValueError, KeyError, struct.error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
