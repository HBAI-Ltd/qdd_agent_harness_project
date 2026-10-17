<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# AI Passport firmware workspace

`@qdd/esp` builds the Device Controller keyboard/mouse bridge on FoloToy AI Passport
(ESP32-C3, 8 MB Flash, no PSRAM, ESP-IDF **5.5.3**). Connect it to the computer
over local Wi-Fi TCP or USB Serial/JTAG, and pair its BLE keyboard/mouse with Android. Android
runs the separate Device Screen Sharing App and sends its screen to the computer
over the local Wi-Fi network. The computer owns the MCP tools. Phone USB is
only needed for initial App installation or diagnostics; input uses no accessibility service.
Live previews offer turbo grayscale, fast, standard and original modes; MCP requests original-size snapshots on demand. App/PC operation requires
no application token or connection code; Android consent and BLE system pairing remain.
See [bridge setup and protocol](docs/android-bridge.md).

The product names are Device Controller, Device Screen Sharing and Device Console. The independent
240 x 320 dark card UI uses `#d4380d` and three fixed, theme-colored, rounded vertical markers on the right, matching UP, DOWN and OK.
They contain no text and are not a scrolling thumb. They touch the visible right edge without a gap, following its rounded corners; the top/bottom end four pixels from the edges.
Home has two vertical choices: Emergency stop / Cancel emergency stop, and Settings. Boot and
returning home default to the stop item. UP/DOWN only select; short OK executes the current item.
Confirming stop immediately inhibits input and latches it. Only local selection and confirmation
can clear it; stop wins over an unlock observed in the same worker round. The PC cannot unlock it.
Before step one on an unconfigured device, the key guide explains the physical buttons. Short OK on Start connection continues to the existing Wi-Fi step without starting a scan. The guide remains available in Settings.
Settings and ordinary pages use UP/DOWN, short OK and explicit vertical Back entries. Input is
inhibited throughout settings; leaving never clears the stop or adds manual enable/pause steps.
The key guide and Bluetooth pairing are available in Settings, preserving existing bonds. The pairing page immediately shows the open window and phone instructions; reopening it gives visible confirmation. It updates from actual Bluetooth state, hides expired passkeys and distinguishes a connected phone from keyboard/mouse readiness. The guide follows the actual enclosure: a tall gray shell, top strap opening, upper-left screen, lower-right diagonal speaker grille and silver right-side keys. Connector lines map the keys to their navigation actions.
Wi-Fi scanning traverses all SDK records and retains up to 64 distinct SSID/security networks,
ordered by signal strength, with four rows per page. Duplicate mesh APs do not consume separate
entries. This China configuration scans 2.4 GHz channels 1 through 13 with a longer dwell time;
ESP32-C3 cannot discover 5 GHz-only networks. Scan lists stay in static storage and only single
entries are copied to UI tasks, avoiding large stack snapshots.
Opening the scan list immediately shows a 40 x 40 animated spinner, a scanning message and a
usual 3–5 second estimate. While scanning, short OK returns to Settings and the scan continues
in the background; UP/DOWN cannot select stale networks. Completion, failure or leaving the page
removes the spinner and its animations.
Wi-Fi password entry retains its four-page, four-row, six-column keyboard and all 95 printable
ASCII characters: choose a row, then a character, using UP/DOWN and OK. This is the explicit
hold exception: holding OK opens the vertical Connect/Continue/Delete one/Clear password/Back menu. Clear password wipes the entire buffer and returns to the keyboard, preserving the selected network and keyboard position. Passwords stay masked.
Settings also offers Reset device. Its vertical confirmation defaults to Back;
only selecting Clear and start again with the physical OK key requests reset.
It releases input, reboots and clears all default NVS data before BLE/Wi-Fi start,
including Wi-Fi credentials and Bluetooth bonds, then returns to initial onboarding.
Firmware and the embedded APK are retained. On the phone, forget the old Bluetooth
pairing and pair again. Installing this firmware alone does not clear settings.
The computer indicator requires a live heartbeat, rather than a plugged cable.
Only changed labels/colors update. Licensed 14/20 px CJK subsets, reproduction
and rendering checks are documented in [assets](assets/README.md).
Protocol operation names and the Bluetooth identifier remain ASCII.

An unconfigured board starts on step 1 of the connection guide. It does not open Wi-Fi settings or scan automatically; select Settings and then Wi-Fi to begin.
The guide omits Emergency stop. QR/App-installation and Bluetooth-pairing instructions can be
skipped, with Settings still available. Skip choices only live in RAM for the current boot and
reset after restart/reset; they do not fabricate download, Bluetooth or input readiness.
Phone control still requires a ready secure BLE connection. The normal control page retains
the locally confirmed emergency stop.

After Wi-Fi connects, the QR page shows `http://<board-IP>:3334/` for scanning
or browser APK download. The landing page and embedded APK use fixed-length SDK responses;
the APK response declares its exact embedded length, and the download flag is set only after
the send succeeds. Active Wi-Fi stays in `WIFI_PS_NONE`
from initialization, including USB use and after a TCP controller disconnects.
During initial onboarding, a successful App registration records that the App has been opened.
This milestone and a completed download survive a Wi-Fi disconnection within the current boot;
they are separate from the 15-second phone/PC registration freshness limit. Leaving the App for
Bluetooth settings or missing its heartbeat no longer returns the guide to the download QR.
Expired registrations hide the old endpoints and projection state; a Wi-Fi disconnection also
invalidates live registrations. After pairing, or when the user skips the pairing instructions, step 5 asks the user to return to the App
and resume screen sharing. Completing initial onboarding still requires fresh phone registration,
active screen sharing and a live controller heartbeat. Restart/reset clears these in-memory milestones.
Phone, PC and board must share the LAN. The PC can
discover it automatically, or set `ESP_HOST` to that IPv4 and `ESP_TCP_PORT`
to control port `3333`; omit `ESP_HOST` to use `ESP_PORT` over USB.
Only one transport controls the board at a time. Losing it releases input.
After reconnect, a fresh controller heartbeat and ready secure BLE link permit
new input without another enable action; held inputs are never replayed.
Wi-Fi credentials stay in the board's
separate NVS profile and never clear Bluetooth bonds.
Initial association retries up to four attempts with 500/1000/2000 ms backoff, remaining in the
connecting state until success or exhaustion. Transient configuration-state conflicts retry after
250 ms; immediate connection-API errors also retry. The board scans all channels, selects by RSSI
without pinning a BSSID, rejects stale/wrong-interface/wrong-SSID IP events, and retains bounded
backoff when reconnecting a previously connected network.

Read [AGENTS.md](AGENTS.md) before development, then follow its task routing.
The [upstream documentation index](docs/README.md) and
[official tutorial](https://ai-passport.folotoy.cn/guides/create-a-play-with-agent/)
explain the hardware and development workflow. A derivative application must
design its own UI instead of reusing the baseline test menu and screens.

## Windows environment

Install ESP-IDF v5.5.3 using Espressif's official Windows Tools Installer.
Keep the installation outside this repository, in a path without spaces, and
include ESP32-C3 support. The
[environment guide](docs/development/engineering/environment-setup.md)
documents other platforms and official download routes.

The npm commands below start a child PowerShell and activate the selected IDF
installation with its official `export.ps1`. They do not change shell startup
files or global environment settings.

Choose an installation using `IDF_PATH`, or create the ignored local file:

```powershell
Copy-Item apps/esp/.idf.local.example.json apps/esp/.idf.local.json
```

Fill in the paths from your own installer. Relative paths resolve from
`apps/esp/`. Empty optional fields are ignored.

| Field | Purpose |
| --- | --- |
| `idfPath` | ESP-IDF checkout containing `export.ps1`, such as `C:/Espressif/frameworks/esp-idf-v5.5.3`. `IDF_PATH` takes precedence. |
| `toolsPath` | Installer tools directory, such as `C:/Espressif`. An existing `IDF_TOOLS_PATH` takes precedence. |
| `pythonPath` | Optional bootstrap `python.exe` from the installer, needed if Python is unavailable in the current shell. The activated IDF virtual environment runs subsequent commands. |
| `bashPath` | Git for Windows `bin/bash.exe`, required by the shared validation gate. If empty, the wrapper searches the Git installation; it does not use WSL Bash. |
| `ccPath` | Native host C compiler, required by the static/full gate. For example, use a portable w64devkit `bin/gcc.exe`. An existing `CC` takes precedence. |

Keep `.idf.local.json` local. It contains machine-specific paths and is ignored
by Git. The example file intentionally contains no installation-specific paths.

## Commands

Run these from the monorepo root after `npm ci`:

| Command | Behavior |
| --- | --- |
| `npm run check:esp` | Check ESP-IDF v5.5.3, Python, CMake, Ninja, and the RISC-V compiler. This is an environment check, not a firmware build or host test run. |
| `npm run build:esp` | Run the shared `tools/validate.sh --firmware` gate: build, merge, verify, and archive matching debugging artifacts. |
| `npm run validate:esp` | Run the complete shared gate, including repository checks, host tests, and the firmware gate. |
| `npm run validate:esp -- --static` | Run repository checks and host tests only. |
| `npm run idf:esp -- --version` | Run a native IDF command after activation and version validation. |
| `npm run idf:esp -- build` | Perform an incremental development build. |
| `npm run idf:esp -- menuconfig` | Open the native IDF configuration menu. |

Additional native IDF arguments are forwarded without rewriting them. For
example, `npm run idf:esp -- -B build/dev build` selects a separate incremental
build directory. Running `idf:esp` without arguments displays IDF help.

`check:esp`, `build:esp`, and `validate:esp` never flash a device. Flashing requires
an explicitly selected native IDF action and the authorization described in
[AGENTS.md](AGENTS.md). The monorepo's existing `npm run build`, `typecheck`, and
`clean` retain their TypeScript behavior; this C workspace has no TypeScript
project reference.

For Linux or macOS, activate ESP-IDF v5.5.3 and run `./tools/validate.sh` directly
from `apps/esp/`. The npm PowerShell wrapper targets native Windows.

## Build output

The firmware gate creates the verified merged image at
`build/FoloToy-AI-Passport-full.bin` and retains a matching manifest, ELF, MAP,
and component images under `build/firmware/<full-bin-sha256>/`. See
[build and test](docs/development/engineering/build-and-test.md) for validation
and archival details. A failed gate may leave earlier outputs in place; do not
treat an earlier image as the result of a failed run.

`build/`, generated `sdkconfig`, and `managed_components/` are ignored. The
tracked `dependencies.lock` pins ESP-IDF Managed Components independently of
the npm lockfile. Compilation and host tests do not prove on-device behavior.

## Source and local integration

- Source: [FoloToy/ai-passport on Gitee](https://gitee.com/FoloToy/ai-passport).
- Imported commit: `a06235e4c94361e3f8a2d498930254101718acae`.
- The QDD application starts in `main/qdd_main.c`; the original hardware-test
  sources remain as unlinked references and host-test fixtures.
- License: [MIT, Copyright (c) 2026 FoloToy](LICENSE); the upstream license and
  attribution are preserved.
- The source is vendored under `apps/esp/` without a nested `.git` directory.
  Upstream `main/`, BSP, partition table, and dependency declarations are
  retained for the initial integration.
- Local integration adds this README pair, the npm workspace manifest,
  ignored local environment configuration, a Windows IDF wrapper, and root npm
  entry points. The shared validation tools also support native Windows Python,
  IDF paths, and the Windows actionlint distribution.
- Future upstream updates must review the local integration changes together
  with the pinned commit and `dependencies.lock`; the nested upstream GitHub
  workflows do not automatically become monorepo workflows.
