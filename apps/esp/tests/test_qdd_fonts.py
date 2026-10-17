#!/usr/bin/env python3
"""Dependency-free audit of checked-in CJK subsets and their actual UI bindings."""

import hashlib
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets/fonts"


def coverage(source):
    result = set(range(0x20, 0x7F))
    offsets = re.search(r"unicode_list_1\[\]\s*=\s*\{([^}]+)\}", source).group(1)
    start = int(re.search(r"\.range_start = (\d+),[^\n]+\n\s*\.unicode_list = unicode_list_1", source).group(1))
    result.update(start + int(value, 16) for value in re.findall(r"0x[0-9a-f]+", offsets))
    return result


class QddFontsTest(unittest.TestCase):
    def test_every_ui_codepoint_is_covered_at_both_sizes(self):
        texts = "".join((ROOT / "main" / name).read_text(encoding="utf8") for name in ("qdd_ui.c", "qdd_ui_model.c", "qdd_setup_model.c", "qdd_main.c"))
        required = {ord(char) for char in texts if ord(char) > 127} | set(range(0x20, 0x7F))
        inventory = {ord(char) for char in (ASSETS / "qdd_glyphs.txt").read_text(encoding="utf8").strip()}
        self.assertEqual(required - set(range(0x20, 0x7F)), inventory)
        manifest = json.loads((ASSETS / "qdd-fonts.json").read_text())
        self.assertEqual(manifest["converter"], "lv_font_conv@1.5.3")
        for font in manifest["files"]:
            path = ROOT / font["path"]
            data = path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), font["sha256"])
            source = data.decode("utf8")
            self.assertEqual(required, coverage(source))
            self.assertNotIn(0x9F98, coverage(source))
            self.assertNotIn(0x1F600, coverage(source))
            self.assertIn(".bitmap_format = 0", source)
            self.assertIn(".bpp = 4", source)
            self.assertIn(".fallback = NULL", source)
            self.assertRegex(source, r"\.range_start = 32, .range_length = 95")

    def test_fonts_are_compiled_and_bound_without_demo_shell(self):
        ui = (ROOT / "main/qdd_ui.c").read_text(encoding="utf8")
        cmake = (ROOT / "main/CMakeLists.txt").read_text()
        for size in (14, 20):
            self.assertIn(f"../assets/fonts/qdd_cjk_{size}.c", cmake)
            self.assertIn(f"&qdd_cjk_{size}", ui)
        self.assertNotIn("ui_pixel", ui)
        self.assertNotIn("lv_font_montserrat", ui)
        self.assertIn("LV_LABEL_LONG_WRAP", ui)
        self.assertIn("strcmp(label->text, value) == 0", ui)

    def test_license_and_reproduction_metadata_are_kept(self):
        license_text = (ASSETS / "OFL-SourceHanSans.txt").read_text()
        self.assertIn("Copyright 2014-2021 Adobe", license_text)
        self.assertIn("SIL OPEN FONT LICENSE Version 1.1", license_text)
        manifest = json.loads((ASSETS / "qdd-fonts.json").read_text())
        self.assertRegex(manifest["sourceSha256"], r"^[0-9a-f]{64}$")
        self.assertIn("v9.5.0", manifest["sourceUrl"])


if __name__ == "__main__":
    unittest.main()
