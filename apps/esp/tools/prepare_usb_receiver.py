#!/usr/bin/env python3
"""Verify the self-contained offline USB HTML and prepare its Flash gzip payload."""
import argparse
import gzip
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re

HTML_NAME = "设备USB接收.html"
SOURCE_FILES = {f"apps/android-mcp-rust/assets/usb-receiver/{name}" for name in
                ("index.html", "receiver.css", "receiver.js")} | {
    "apps/android-mcp-rust/tools/prepare-usb-receiver.mjs",
    "apps/android-mcp-rust/tools/test-usb-receiver.mjs",
}


class OfflineHtml(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.has_html = False
        self.scripts = []
        self.styles = []
        self.active = None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if len(attrs) != len(attributes):
            raise ValueError("offline HTML must not have ambiguous duplicate attributes")
        if tag in {"base", "link", "iframe", "frame", "object", "embed"}:
            raise ValueError("offline HTML must not depend on external documents")
        if any(name.startswith("on") for name, _ in attributes):
            raise ValueError("offline HTML must use its bundled script instead of event attributes")
        for name, value in attributes:
            if name in {"src", "srcset", "poster", "data", "action", "formaction", "href", "xlink:href", "background"}:
                bootstrap_link = tag == "a" and name == "href" and value == "/qdd-usb-receiver.html"
                fragment_link = tag == "a" and name == "href" and value and value.startswith("#")
                if value and not fragment_link and not bootstrap_link and not (tag == "img" and name == "src" and value.startswith("data:image/")):
                    raise ValueError("offline HTML contains an external resource or navigation")
            if name == "style" and value and re.search(r"@import\b|url\s*\(", value, re.I):
                raise ValueError("offline inline style has an external runtime dependency")
        if tag == "meta" and attrs.get("http-equiv", "").lower() == "refresh":
            raise ValueError("offline HTML must not redirect")
        if tag == "script":
            if "src" in attrs:
                raise ValueError("offline script must be inline")
            self.scripts.append("")
            self.active = self.scripts
        elif tag == "style":
            self.styles.append("")
            self.active = self.styles
        if tag == "html":
            self.has_html = True

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.active = None

    def handle_data(self, data):
        if self.active is not None:
            self.active[-1] += data


def validate_html(data: bytes) -> None:
    if not 1 <= len(data) <= 128 * 1024:
        raise ValueError("offline HTML must be nonempty and at most 128 KiB")
    text = data.decode("utf-8")
    if "\x00" in text:
        raise ValueError("offline HTML contains NUL")
    document = OfflineHtml()
    document.feed(text)
    document.close()
    if not document.has_html or not document.scripts or not any(document.scripts):
        raise ValueError("offline HTML needs a bundled inline application")
    script = "\n".join(document.scripts)
    if re.search(r"\bimport\b|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|sendBeacon)\s*\(", script):
        raise ValueError("offline HTML script has an external runtime dependency")
    if re.search(r"@import\b|url\s*\(", "\n".join(document.styles), re.I):
        raise ValueError("offline HTML style has an external runtime dependency")


def prepare(manifest_path: Path, html: Path, output: Path, header: Path,
            source_root: Path = None) -> dict:
    paths = [path.resolve() for path in (manifest_path, html, output, header)]
    if len(set(paths)) != len(paths):
        raise ValueError("receiver inputs and outputs must be distinct")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    inputs = manifest.get("sourceInputs")
    if (not isinstance(inputs, list) or len(inputs) != len(SOURCE_FILES) or
            any(not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in inputs) or
            {item.get("path") for item in inputs} != SOURCE_FILES):
        raise ValueError("offline receiver source identity is incomplete")
    source_root = source_root or Path(__file__).resolve().parents[3]
    for item in inputs:
        source = (source_root / item["path"]).read_bytes()
        if (type(item.get("bytes")) is not int or item["bytes"] != len(source) or
                item.get("sha256") != hashlib.sha256(source).hexdigest()):
            raise ValueError("offline receiver source changed; rebuild the HTML")
    if not 1 <= html.stat().st_size <= 128 * 1024:
        raise ValueError("offline HTML must be nonempty and at most 128 KiB")
    data = html.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if (type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1 or
            manifest.get("platform") != "browser" or manifest.get("protocol") != "QDDDRV/1" or
            manifest.get("html") != HTML_NAME or html.name != HTML_NAME or
            manifest.get("selfContained") is not True or
            type(manifest.get("bytes")) is not int or manifest["bytes"] != len(data) or
            not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("sha256", ""))) or
            manifest["sha256"] != digest):
        raise ValueError("offline receiver does not match its manifest")
    validate_html(data)
    compressed = gzip.compress(data, compresslevel=9, mtime=0)
    if gzip.decompress(compressed) != data:
        raise ValueError("offline receiver gzip verification failed")
    for target in (output, header):
        target.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(compressed)
    if output.read_bytes() != compressed:
        raise ValueError("saved receiver differs from prepared gzip")
    header.write_text(
        "#pragma once\n"
        f"#define QDD_USB_RECEIVER_SIZE {len(data)}u\n"
        f"#define QDD_USB_RECEIVER_SHA256 \"{digest}\"\n"
        f"#define QDD_USB_RECEIVER_GZIP_SIZE {len(compressed)}u\n",
        encoding="utf-8", newline="\n")
    return {"sourceBytes": len(data), "sourceSha256": digest,
            "gzipBytes": len(compressed), "gzipSha256": hashlib.sha256(compressed).hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("html", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("header", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.manifest, args.html, args.output, args.header)))
        return 0
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
