<p align="right"><a href="README.zh_CN.md">简体中文</a> · <strong>English</strong></p>

# Device Console · 设备操作台

Install [Device Screen](../android-screen/README.md) on the phone. With explicit MediaProjection
consent, one long-lived MJPEG connection continuously sends selectable-quality previews to this PC.
The operator displays that stream; MCP screenshots and post-action images separately request fresh original-resolution JPEGs.
The device controller (ESP32-C3) connects to the PC over Wi-Fi TCP (or USB serial) and to the phone as a BLE keyboard/mouse.

```text
Device Screen → continuous Wi-Fi MJPEG preview → PC latest-frame cache → Device Console
Device Screen → fresh original JPEG on request → PC MCP images
Mouse/keyboard/MCP input → PC Wi-Fi TCP (or USB) → device controller → BLE HID → phone
```

Runtime screen capture needs neither phone USB nor ADB; ADB may install the APK initially.
Input uses hardware HID, without accessibility, ADB input, clipboard injection or a model API key. Inspired by
[esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent), adapted to ESP32-C3 BLE HID.

## Windows EXE

Run `build/windows/设备操作台.exe`; the target PC needs no separate Node.js, npm or
dependency installation. Double-clicking starts MCP and opens the operator. The adjacent
`qdd-android.json` stores local connection settings. A missing configuration opens setup;
the operator's **连接设置** link edits it later.

1. Join the same Wi-Fi on the device controller. Scan its QR/IP page on the phone to download/install the App, then open it from the page.
2. Follow the App/controller Bluetooth guide; existing bonds are retained. Tap **开始投屏** and accept screen sharing.
3. Open the PC EXE, click **自动查找** in settings, confirm the target board and save. USB serial is also an explicit option (`COM5` here).
4. Click the live picture to operate; press Esc to return to the PC. Multiple boards require a choice; manual phone addresses remain available.

The console shows its actual LAN address, such as `http://192.168.1.10:8790/`.
Open that address from the phone or another computer on the same LAN. HTTP MCP
clients use the same address with `/mcp`, such as `http://192.168.1.10:8790/mcp`,
without a token. Replace the sample IP with the address shown by the console.
For stdio, first stop
the HTTP service that owns the control board, then configure an absolute EXE path:

```json
{
  "mcpServers": {
    "deviceController": {
      "command": "F:\\aidol\\qdd_agent_harness_project\\apps\\android-mcp\\build\\windows\\设备操作台.exe",
      "args": ["--stdio"]
    }
  }
}
```

`--help` lists options; `--self-test` verifies embedded resources and the serial module.
Closing the EXE console or pressing Ctrl+C releases input and stops the service.
Launching the same build/configuration again reuses the existing service. Settings reload
closes old connections and starts the new service in the same EXE, without replaying input.
Update the address if the phone IP changes. ADB is for installation, setup and diagnostics;
runtime pictures always come from phone Wi-Fi.

The HTTP service listens on `0.0.0.0` by default and accepts only loopback or
private IPv4 LAN peers, Host headers and browser origins. HTTP CORS and realtime
WebSocket access use the same boundary; public addresses/origins are rejected.
`/health` reports `operatorUrl`, `mcpUrl` and alternative `lanUrls`. Physical Wi-Fi
and Ethernet addresses are preferred for display; without a private LAN interface,
the console falls back to `http://localhost:8790/`. `0.0.0.0` is the listen address,
not an address to type into the browser.

## Develop and start from source

1. Install Node.js 24+ and npm 11+; run `npm ci` from the repository root.
2. Build/install the [Device Screen APK](../android-screen/README.md#build-on-windows),
   connect phone and PC to the same Wi-Fi LAN, then open **设备投屏**.
3. Flash the [device controller firmware](../esp/docs/android-bridge.md), then use UP/DOWN to select settings on its main screen and confirm to enter Wi-Fi.
   Its screen keyboard enters the password. Connect phone, PC and board to the same LAN;
   select the Bluetooth name shown on the controller in the phone's Bluetooth settings.
4. Copy `apps/android-mcp/.env.example` to `.env` and fill in actual local values:

| Setting | Value |
| --- | --- |
| `ANDROID_SCREEN_URL` | App-displayed private IPv4 URL, e.g. `http://192.168.1.20:8791`; replace the example with your phone's address |
| `ANDROID_DEVICE_ID` | Optional exact app-generated UUID, not an ADB serial |
| `ESP_HOST` | Board-displayed LAN IPv4 or local hostname; Wi-Fi takes priority |
| `ESP_TCP_PORT` | Board TCP port, default `3333` |
| `ESP_SETUP_URL` | Optional board onboarding page filled by discovery, e.g. `http://192.168.1.30:3334` |
| `ESP_PORT` | Optional USB serial port, such as `COM5`, used when `ESP_HOST` is empty |
| `ANDROID_MCP_PORT` | LAN HTTP port; default `8790`, listening on `0.0.0.0` |

5. On the phone, tap **开始投屏** and accept the system screen-sharing consent.
   Update the URL when the phone's Wi-Fi address changes; guest Wi-Fi client isolation can block access.
6. From the repository root, run:

```powershell
.\start-android.cmd
# Headless foreground service:
.\start-android.cmd --no-browser
```

The Node launcher reads `.env`, builds missing `dist/`, and reuses a healthy local service
or starts one in the foreground. The panel automatically connects to the local service without a token.
Ctrl+C closes a service started by this launcher. It never installs apps, flashes firmware or sends phone input.

The panel automatically connects without a token. Its instruction is:
**点击画面操作，Esc退出** — click the picture to enter, press Esc to exit.
The first picture click establishes remote control and is not sent to the phone.
Subsequent mouse movement, clicks, dragging, scrolling and typing operate the phone's
real pointer. The computer cursor is hidden across the whole page while controlling;
no substitute pointer is drawn. The current OnePlus/IAB interaction checks passed;
high-frame-rate continuous smoothness remains unaccepted. See the record below.

Human mouse movement sends relative HID motion and allows the phone's configured
acceleration. It does not map an absolute browser position to a phone pixel, and
does not require calibration, corner homing or the AI coordinate path's 100 ms pacing.
When PointerLock is available, relative movement is unlimited. If capture is refused,
relative input continues across the browser page. Moving outside the picture does
not exit control. Press Esc to exit and restore the computer cursor.
There are no start, capture or pause buttons. While controlling, page clicks go to
the phone rather than also activating the toolbar. After Esc, toolbar actions work
directly and prepare their connection internally. Coordinate adjustment settings
apply to AI taps/swipes only; the phone determines the real pointer's speed and acceleration.

Choose **画质** beside the live-picture title. Press **Esc** to leave remote control
before changing it; while controlling, page clicks continue to belong to the phone.
The setting persists in the phone App and applies to its existing preview stream.

| Choice | Profile | Preview short edge | Color | JPEG quality |
| --- | --- | --- | --- | --- |
| 极速（灰度） / Turbo | `turbo` | 360 px | Grayscale | 45 |
| 快速 / Fast | `fast` | 540 px | Color | 60 |
| 标准 / Standard (default) | `standard` | 720 px | Color | 70 |
| 原画 / Original | `original` | Physical display size | Color | 75 |

Only the preview is downsampled; its aspect ratio stays unchanged and smaller
screens are not upscaled. MCP screenshots and images returned after actions always
request a newly acquired, original-resolution color JPEG at quality 75 from
`/frame.jpg`. For a 1080×2400 phone, the standard preview is 720×1600 and MCP
coordinates still use 1080×2400. Stream `width`/`height` describe the actual JPEG;
`deviceWidth`/`deviceHeight` describe the physical display used for relative mouse
scaling and AI coordinates. Changing preview quality does not invalidate calibration
or count as a device rotation. The picture's size readout reports the actual JPEG,
not an inferred original resolution.

The operator uses LAN-accessible `GET /screen/profile` to read the phone setting
and `POST /screen/profile` with JSON to change it:

```powershell
Invoke-RestMethod http://192.168.1.10:8790/screen/profile
Invoke-RestMethod http://192.168.1.10:8790/screen/profile -Method Post `
  -ContentType "application/json" -Body '{"profile":"fast"}'
```

The result contains `profile` and, when known, `deviceWidth`/`deviceHeight`.
The PC forwards these requests to the phone's `GET`/`POST /preview/profile`.
Both POST endpoints accept exactly one profile field with one of the four IDs;
the JSON body limit is 256 bytes. Profile requests need no MCP session and never
arm, pause or claim input. Rapid UI changes keep only the newest pending choice;
on failure, the selector reads back the actual setting and reports the reason.
An older phone App can still stream, but switching quality requires an updated APK;
the panel explicitly displays that upgrade requirement.

There is no two-second screenshot polling. The phone uses `/stream.mjpg`, the PC keeps only the
latest frame, and `/screen/stream` carries binary JPEG records to the operator without
Base64 encoding. `/screen/events` remains a compatibility endpoint. Slow viewers skip frames;
the browser also keeps at most one pending decode. Continuous capture targets a fixed
33 ms interval (about 30 fps) at the selected preview quality, without downgrading static screens.
Capture and JPEG encoding run separately, replacing old pending images with the latest.
This is a target; delivered frame rates depend on the device and LAN throughput.
Browser queue/transfer/decode time counts toward the same three-second freshness limit.
Relative motion accumulates behind a bounded window of four in-flight reports, so later
motion need not wait for every Wi-Fi acknowledgement. Per-round sequence numbers preserve
mouse button/key edges. Fast swipe overflow only coalesces/clamps motion instead of
incorrectly disconnecting. Missing sequence numbers, cancellation or failed acknowledgements
release input without replay. Ordinary AI actions wait for earlier realtime reports,
then run exclusively. This improves possible throughput, not guaranteed latency. While mouse
control is active, a session-bound heartbeat renews every 250 ms; 900 ms without renewal releases input.
Browser reports and renewals use a separate WebSocket, avoiding the persistent video/MCP
HTTP connection pool. Renewals do not wait for input ACKs.
Source loss, page hiding, browser-window focus loss or capture loss stops control
and releases input. Picture-edge crossing and same-page element focus do not exit.
A restored picture does not re-enter control automatically. On the device controller,
use UP/DOWN to select **紧急停止** (Emergency stop, selected by default), then press
OK to confirm. To release the physical lock, select **取消急停** (Cancel emergency stop)
and confirm on the controller. The PC cannot unlock it. Settings also use vertical
UP/DOWN selection and OK confirmation.

The v8 firmware validates connection, encryption, bonding, subscriptions, heartbeat
and the physical lock on normal input. Its first valid MOVE/KEY/CONSUMER releases old
reports and activates input without a manual ARM step. The v8 firmware gate,
NVS-preserving flash and no-ARM device checks completed. MCP compatibility ARM/PAUSE tools remain
available internally; the webpage does not expose a manual enable/disable flow.

For trusted local pairing setup, stop MCP first, then run `node apps/android-mcp/tools/pair.mjs`;
`--status` reads the currently displayed PIN.
It opens a two-minute pairing window without erasing bonds or clearing the stop
lock. PINs stay in the local USB terminal, never MCP tools or saved logs.

## Connect an MCP client

HTTP clients connect to the displayed LAN MCP address, for example
`http://192.168.1.10:8790/mcp`, without authentication headers. Localhost also works
on the host PC. The server binds to `0.0.0.0`, checks the private peer/Host/Origin,
and supports cancellation and DELETE session termination. Closing
the session that owns input releases it. Closing a read-only observer session or video
viewer does not stop another operator; loss of the actual phone source still releases input.

For stdio, stop the HTTP service first to release the ESP connection, or keep HTTP
running and use its shared endpoint. Generate a direct absolute Node command:

```powershell
$nodePath = (Get-Command node -CommandType Application).Source
$entryPath = (Resolve-Path ./apps/android-mcp/dist/index.js).Path
@{ mcpServers = @{ deviceController = @{ command = $nodePath; args = @($entryPath, "--transport", "stdio") } } } |
  ConvertTo-Json -Depth 6
```

Use Node directly so npm banners cannot corrupt stdio; the entry point loads its own `.env` regardless of client working directory.
Overrides include `--screen-url`, `--device` (app UUID), `--esp-host`, `--esp-tcp-port`, `--esp-port`, and `--transport`.
Use a client that accepts MCP image results; the repository's existing CLI model conversation
is not automatically connected to this standalone service's screenshots.

## Tools and coordinate limits

| Tools | Purpose |
| --- | --- |
| `android_control` | Preferred observe-act-observe workflow: one action followed by a genuinely newer phone image |
| `android_devices`, `android_screenshot`, `android_hid_status` | Configured phone, JPEG image, bridge readiness |
| `android_hid_arm`, `android_hid_pause`, `android_release` | Explicit arm, cancel queued input, release held reports |
| `android_mouse_move`, `android_mouse_click`, `android_scroll` | Relative counts, current-position clicks, wheel |
| `android_calibrate_pointer`, `android_pointer_home`, `android_tap`, `android_swipe` | Calibrated estimated coordinates |
| `android_type`, `android_key`, `android_key_report` | US-layout ASCII, chords, raw keyboard reports |
| `android_consumer_report`, `android_home`, `android_back` | Raw consumer usages and Home/Back |

There are 20 tools. Start with `android_screenshot`, then call `android_control`
using that result's `frameId`. For example, `{ "action": "move", "frameId": "<latest-frameId>",
"dx": 80, "dy": 0 }` moves the real mouse and returns a new image captured after the
action completed. Continue with the returned `frameId`. It prepares input internally;
move/click/scroll/key/type/home/back need no pointer calibration. `wait` observes after
a delay without enabling input. A physical emergency lock always prevents input.

`android_control` tap/swipe still require explicit measured calibration. Legacy individual
input tools retain `android_hid_arm` and a separate screenshot after acting. Human relative
control and raw relative movement do not require coordinate calibration. If a resulting image
times out, inspect `actionStarted`, `actionCompleted` and `observedAfterAction`; when the action
completed, observe with `android_screenshot` instead of blindly repeating it.
Cancellation and the post-action image deadline also cancel the underlying original
HTTP request; queued cancelled captures are skipped so they cannot delay the next observation.
Images include original dimensions, physical `deviceWidth`/`deviceHeight`,
`previewProfile: "original"`, SHA-256, capture time and a session-local `frameId`;
source frames older than three seconds are rejected.
Each session keeps its own latest frame for at most 30 seconds; another session's
screenshot does not supersede it. Homing, taps and swipes recheck the frame when
leaving the queue, before sending any reports; expired or superseded frames stop
and pause input. A shared identity/geometry/rotation epoch
invalidates every session's old frames after phone, dimensions or rotation changes,
including 180-degree rotation. These changes stop input and clear calibration.

Scales mean HID counts per screenshot pixel; 200 counts moving 100 pixels means
scale 2. Positions remain estimates. Pixel and `normalized1000` coordinates are
supported. Recalibrate after pointer-speed or keyboard/mouse settings changes.
Coordinate actions settle for 550 ms after homing, then wait at least 100 ms after
each nonzero positioning/drag report ACK, including the last positioning report
before a click. This pacing addressed acceleration observed on the tested phone.
Swipe `durationMs` is a minimum; `plannedDurationMs` may grow to preserve pacing
and excludes homing/movement to the start. One coordinate action allows at most
300 combined homing, positioning and drag reports. Raw relative movement keeps its own semantics.

Typing validates the entire string and supports US-layout ASCII, tab and newline.
Non-ASCII is rejected before any prefix is typed. Select an English hardware keyboard layout; Unicode/clipboard injection is unavailable.
Home/Back mappings and mouse dragging depend on the phone and target app.
Screen capture failures, cancellation and transport/report faults stop input;
held reports are released. Once the connection is ready again, click the picture
to re-enter human control; MCP clients retain the compatibility control flow above. Firmware
also stops on BLE loss or a missing PC heartbeat for more than 1500 ms.

## Validation

`src/*.test.ts` covers the protocol, shared input controller, TCP/serial transports,
preview parser/cache, separate original captures and official MCP HTTP/stdio clients. `tests/operator.test.mjs`
executes the actual browser script in a VM to check frame-loss/decode races,
mouse capture, held-key release, quality-change races, physical-coordinate scaling and old-runtime detection. Both run with
`npm run test:android` from the repository root.

Run `npm run typecheck`, `npm run build`, and `npm run test:android` at the root.
Build the EXE on Windows x64 with the pinned Node 24.15.0:

```powershell
npm run build:exe --workspace @qdd/android-mcp
npm run test:exe --workspace @qdd/android-mcp
node apps/android-mcp/tools/soak-exe.mjs
```

EXE checks launch with empty PATH and Chinese/space paths, covering first setup,
duplicate launch, same-process reloads, official HTTP/stdio MCP and embedded resources.
The sustained stress fixture uses a loopback phone/ESP; it is not physical-device acceptance.
Tests use mocked devices plus official MCP clients for stdio and loopback HTTP.
JPEG reception validates dimensions, segment lengths, scans and the complete ending;
PNG adapters remain supported for existing fixtures. Current device results and remaining checks are recorded below.
The retained `tools/preview.ps1` is optional read-only USB/scrcpy diagnostics only;
it does not supply product screenshots or participate in the LAN runtime path.

See the [acceptance record](docs/acceptance.md) for observed results, artifact hashes
and remaining physical-device checks.
