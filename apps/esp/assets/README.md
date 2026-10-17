<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# Assets

This directory stores reusable fonts, images, music, and sound effects, organized by asset type.

Keep each asset in the matching subdirectory and document its destination, naming, integration method, and source/license. Do not mix binary assets with Markdown documentation.

## Fonts

Store reusable font files and generated font sources in `fonts/`.

- Use descriptive names that include the family, weight, size, and format when relevant.
- Document the source, license, character range, conversion command, and expected destination.
- Check Flash and internal-RAM impact before adding a font; the ESP32-C3 has no PSRAM.
- Do not commit fonts whose license does not permit redistribution.

### QDD Chinese controller fonts

`fonts/qdd_cjk_14.c` and `fonts/qdd_cjk_20.c` are bitmap subsets derived from
the Source Han Sans SC Normal OTF bundled with LVGL **9.5.0**. They use
**SIL OFL 1.1**; Adobe's copyright and complete license are retained in
[`fonts/OFL-SourceHanSans.txt`](fonts/OFL-SourceHanSans.txt). Derived font symbols
use QDD names. The source is a pinned managed dependency, without a second
16 MB OTF copy. Its upstream URL/SHA-256, converter version and generated-file
hashes are in [`fonts/qdd-fonts.json`](fonts/qdd-fonts.json).

After managed dependencies are available, run `node tools/generate_qdd_fonts.mjs`
from `apps/esp/`. It uses official `lv_font_conv@1.5.3`, 4 bpp, no compression
and no kerning. Both sizes cover all 95 printable ASCII characters U+0020..U+007E and 222 non-ASCII
characters collected from the UI, setup model and application feedback in [`fonts/qdd_glyphs.txt`](fonts/qdd_glyphs.txt).
Actual line heights are **17/24 px**, not the nominal 14/20 px sizes.
`main/CMakeLists.txt` compiles each font once; every label selects its font.
Bitmap/descriptor data stay constant in Flash. There is no runtime font loader,
full CJK family, PSRAM or enlarged display buffer.

The UI supports fixed Chinese messages and the full printable ASCII password
keyboard. Scanned SSIDs keep their original 32-byte UTF-8 names for connection;
supported glyphs display normally, long names shorten only on-screen, and an
unsupported name displays a network number plus BSSID suffix instead of boxes.
It does not provide arbitrary Chinese text entry. `tests/test_qdd_fonts.py` audits inventory drift,
cmaps, negative glyphs, hashes and bindings. `tests/qdd_ui_host/` uses actual
LVGL 9.5 glyph lookup/RGB565 rendering to check home, onboarding, key guide and setup states, wrapped-label bounds and fixed theme-indicator pixels and incremental/full redraw equality,
the 30 px corner mask, and unchanged-refresh allocations/flushes with a 24 KiB
pool. Physical-panel rendering and system free heap/largest block with BLE are
separate device checks.
With a native C/C++ compiler and CMake, configure using
`cmake -S tests/qdd_ui_host -B build/ui-host`, then
`cmake --build build/ui-host` from `apps/esp/`. Run `qdd_ui_host` (`.exe` on Windows)
from an ignored output directory, passing the absolute `qdd_glyphs.txt` path;
it writes PPM frames and reports glyph/layout/memory/refresh checks.
The three text-free theme indicators are custom-drawn; the setup keyboard retains four custom-drawn rows instead of one LVGL widget per key.
Before adding the reset page, the measured 24 KiB host pool peaked at 17,080 bytes; the new reset page has not been exercised because device testing was explicitly skipped. Unchanged
home/setup refreshes allocate nothing and flush nothing. One hundred and twenty screen switches
retain the same live allocation count and bounded allocator alignment cycle.

## Images

Store reusable source images and generated display assets in `images/`.

| File | Dimensions and format | Use and source |
| --- | --- | --- |
| [`images/home.jpg`](images/home.jpg) | 3840 × 2160, JPEG | Product hero image embedded in both project README files to foreground AI Passport and its open, maker-oriented identity. |
| [`images/readme-hardware-specs.png`](images/readme-hardware-specs.png) | 2172 × 724, PNG RGBA | Optional technical infographic retained as a reference asset; it is no longer used as the homepage hero. Generated for this repository with the built-in image generation tool on 2026-09-17; the six labels and values were checked against the documented hardware contract. |
| [`images/logo-wordmark.png`](images/logo-wordmark.png) | 1648 × 336, PNG RGBA | Transparent black wordmark extracted from the repository's original `images/logo.png`; embedded in both project README files for light backgrounds. |
| [`images/logo-wordmark-dark.png`](images/logo-wordmark-dark.png) | 1648 × 336, PNG RGBA | White version of the extracted wordmark, used by the README `<picture>` element when GitHub is in dark mode. |

- Use descriptive names and document dimensions, pixel format, conversion steps, and destination.
- Prefer formats suitable for the 240 × 320 RGB565 display and account for Flash and internal RAM.
- Preserve editable sources where licensing permits, and record the source and license.
- Never commit device QR secrets, credentials, or personal data in images.

## Music and sound effects

Store reusable music and sound-effect sources in `music/`.

- Document the source, license, sample rate, bit depth, channels, conversion command, and destination.
- Prefer 16 kHz, 16-bit mono PCM when it matches the current BSP audio path.
- Check Flash and internal-RAM cost before embedding audio; stream or chunk long recordings.
- Do not commit media without redistribution permission.
