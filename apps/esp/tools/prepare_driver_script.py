#!/usr/bin/env python3
"""Precompress the bounded public download module; no ESP-side decompression."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path


def prepare(source: Path, output: Path) -> dict:
    if source.resolve() == output.resolve():
        raise ValueError("compressed output cannot overwrite source")
    data = source.read_bytes()
    if not 0 < len(data) <= 32768:
        raise ValueError("download script must be nonempty and at most 32 KiB")
    data.decode("utf-8", errors="strict")
    compressed = gzip.compress(data, compresslevel=9, mtime=0)
    if gzip.decompress(compressed) != data:
        raise ValueError("compressed script verification failed")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(compressed)
    saved = output.read_bytes()
    if saved != compressed or gzip.decompress(saved) != data:
        raise ValueError("saved compressed script verification failed")
    return {"sourceBytes": len(data), "gzipBytes": len(saved),
            "sourceSha256": hashlib.sha256(data).hexdigest(),
            "gzipSha256": hashlib.sha256(saved).hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.source, args.output)))
        return 0
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
