import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from prepare_usb_receiver import HTML_NAME, SOURCE_FILES, prepare

HTML = b'<!doctype html><html><style>body{color:black}</style><body><script>const protocol="QDDDRV/1";</script></body></html>\n'


class UsbReceiverTests(unittest.TestCase):
    def fixture(self, folder, data=HTML):
        root = Path(folder)
        self.manifest, self.html = root / "manifest.json", root / HTML_NAME
        self.output, self.header = root / "out/receiver.gz", root / "out/receiver.h"
        self.sources = root / "sources"
        inputs = []
        for name in sorted(SOURCE_FILES):
            source = self.sources / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"fixture source\n")
            inputs.append({"path": name, "bytes": 15, "sha256": hashlib.sha256(b"fixture source\n").hexdigest()})
        self.html.write_bytes(data)
        self.value = {"schemaVersion": 1, "platform": "browser", "protocol": "QDDDRV/1", "html": HTML_NAME,
                      "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "selfContained": True,
                      "sourceInputs": inputs}
        self.save_manifest()

    def save_manifest(self):
        self.manifest.write_text(json.dumps(self.value), encoding="utf-8")

    def run_prepare(self):
        return prepare(self.manifest, self.html, self.output, self.header, self.sources)

    def test_exact_html_roundtrip_and_deterministic_gzip(self):
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            first = self.run_prepare()
            self.assertEqual(gzip.decompress(self.output.read_bytes()), HTML)
            self.assertEqual(self.output.read_bytes()[4:8], bytes(4))
            self.assertIn(first["sourceSha256"], self.header.read_text(encoding="utf-8"))
            self.assertEqual(first, self.run_prepare())
        with tempfile.TemporaryDirectory() as folder:
            data = HTML.replace(b"</body>", b'<a href="/qdd-usb-receiver.html" download>Save offline copy</a></body>')
            self.fixture(folder, data)
            self.run_prepare()
            self.assertEqual(gzip.decompress(self.output.read_bytes()), data)

    def test_manifest_and_source_identity_fail_before_writing(self):
        for key, bad in (("schemaVersion", True), ("platform", "win32-x64"), ("protocol", "QDDHID/1"),
                         ("bytes", True), ("bytes", len(HTML) + 1), ("sha256", "0" * 64),
                         ("html", "different.html"), ("selfContained", False)):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                self.fixture(folder)
                self.value[key] = bad
                self.save_manifest()
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            (self.sources / sorted(SOURCE_FILES)[0]).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "source changed"):
                self.run_prepare()
            self.fixture(folder)
            self.value["sourceInputs"][0]["path"] = "../../private.env"
            self.save_manifest()
            with self.assertRaisesRegex(ValueError, "incomplete"):
                self.run_prepare()
            self.assertFalse(self.output.exists())

    def test_external_resources_scripts_and_styles_are_rejected(self):
        bad = [b'<script src="https://host/app.js"></script>', b'<link rel="stylesheet" href="local.css">',
               b'<iframe src="local.html"></iframe>', b'<img src="logo.png">', b'<base href="https://host/">',
               b'<a href="https://host/">external</a>', b'<meta http-equiv="refresh" content="0;url=https://host/">',
               b'<script>fetch("https://host/")</script>', b'<script>import("app.js")</script>',
               b'<script>import x from "app.js"</script>', b'<script>new WebSocket("wss://host/")</script>',
               b'<script>import "app.js";</script>', b'<div style="background:url(image.png)">style</div>',
               b'<style>@import "style.css";</style>', b'<style>body{background:url(image.png)}</style>',
               b'<button onclick="fetch(1)">button</button>',
               b'<meta http-equiv="refresh" http-equiv="x" content="0;url=https://host/">',
               b'<img srcset="#a 1x, https://host/a.png 2x">', b'<body background="https://host/a.png">']
        for fragment in bad:
            with self.subTest(fragment=fragment), tempfile.TemporaryDirectory() as folder:
                self.fixture(folder, HTML.replace(b"</body>", fragment + b"</body>"))
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())

    def test_size_utf8_null_and_input_preservation(self):
        for data in (b"", b"x" * (128 * 1024 + 1), b"\xff", HTML + b"\0", b"<html>no inline app</html>"):
            with self.subTest(size=len(data)), tempfile.TemporaryDirectory() as folder:
                self.fixture(folder, data)
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())
        with tempfile.TemporaryDirectory() as folder:
            self.fixture(folder)
            with self.assertRaises(ValueError):
                prepare(self.manifest, self.html, self.html, self.header, self.sources)
            self.assertEqual(self.html.read_bytes(), HTML)


if __name__ == "__main__":
    unittest.main()
