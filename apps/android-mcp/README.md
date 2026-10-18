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
| `android_preview_tap` | Read-only target marker and enlarged crop before choosing a click position |
| `android_pointer_calibration` | `auto` reads actual mouse events on the dedicated page; `probe/finish` measures a visible cursor |
| `android_calibrate_pointer`, `android_pointer_home`, `android_tap`, `android_swipe` | Calibrated estimated coordinates |
| `android_type`, `android_key`, `android_key_report` | US-layout ASCII, chords, raw keyboard reports |
| `android_consumer_report`, `android_home`, `android_back` | Raw consumer usages and Home/Back |

There are 22 tools. Start with `android_screenshot`, then call `android_control`
using that result's `frameId`. For example, `{ "action": "move", "frameId": "<latest-frameId>",
"dx": 80, "dy": 0 }` moves the real mouse and returns a new image captured after the
action completed. Continue with the returned `frameId`. It prepares input internally;
move/click/scroll/key/type/home/back need no pointer calibration. `wait` observes after
a delay without enabling input. A physical emergency lock always prevents input.

`android_control` hover/tap/swipe still require explicit measured calibration. Legacy individual
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

### Preview a target before pressing

Use `android_preview_tap` when a small control is hard to locate. Given this
session's latest `frameId`, `x`, `y` and optional `coordinateSpace` (`pixels` by
default, or `normalized1000`), it captures a fresh original phone image and
returns two views: the full-size image with a conspicuous simulated target
marker, then a 2× enlarged crop around that target. The underlying phone image
is real; the marker is drawn on the returned image only. It never moves the real
mouse, clicks, enables input or takes over another input owner, and needs no
calibration. Expired frames, coordinates outside the image, and changed phone
identity, dimensions or rotation are rejected.

```json
{ "frameId": "<latest-frameId>", "x": 540, "y": 1200, "coordinateSpace": "pixels" }
```

Use the original image's dimensions when choosing a point. A client may shrink
the displayed image; coordinates read from that display must be converted to
original pixels, or expressed in `normalized1000`. The enlarged crop has its own
coordinate origin and scale. Its response metadata describes the target in
original pixels and the crop-to-original conversion. Continue with the new
`frameId` returned by the preview. A simulated marker confirms the chosen visual
target; it does not prove that the physical mouse has reached that position.

The response exposes `target: { x, y, coordinateSpace: "pixels" }`,
`crop: { x, y, width, height, scale: 2 }`, and the marked point's `zoomTarget` in
`zoomPixels`. Convert a point read from the enlarged crop back with
`originalX = crop.x + zoomX / crop.scale` and the equivalent Y formula, then round
to integer pixels. `normalized1000` accepts integers from 0 through 1000 on each
axis. `simulatedTarget: true`, `realMouseMoved: false` and `realClickSent: false`
make the preview-only result explicit. `sourceSha256`/`sourceMimeType` identify the
unannotated source; `annotatedImageSha256` and `zoomImageSha256` identify the two
rendered images. `tapArguments` supplies a ready-to-use `android_control` tap for
the selected original-pixel target; use it only after checking the preview.

For a safer physical click, use these separate steps:

1. Preview the proposed point and adjust it if the marker misses the intended control.
2. Call `android_control` with `action: "hover"`, the preview's `frameId` and
   the point. Hover uses measured calibration to move the real mouse without
   pressing any button, then returns a newer real phone image.
3. Inspect the actual cursor in that image. If it is correctly placed, call
   `android_control` with `action: "click"` and the hover result's `frameId`.
   This presses at the current mouse position without repeating coordinate motion.
   If it is off target, use a small relative `move`, inspect the returned image,
   and click only after confirming the real cursor.

```json
{ "action": "hover", "frameId": "<preview-frameId>", "x": 540, "y": 1200, "coordinateSpace": "pixels" }
```

```json
{ "action": "click", "frameId": "<hover-result-frameId>" }
```

Hover accepts the same pixel or `normalized1000` coordinates as tap and requires
calibration. This check can reveal calibration or mouse-acceleration error before
the button is pressed. The existing direct `tap` remains available; prefer the
preview → hover → inspect → click flow for small or consequential targets.

### Measure pointer calibration with the AI

If the tablet omits its system cursor from captured images, manually open **打开指针校准页**
inside the screen-sharing App, keep that page in the foreground, take a fresh screenshot and call:

```json
{ "phase": "auto", "frameId": "<calibration-page-frameId>" }
```

This sends two small button-free ESP BLE mouse movements and computes both counts/pixel scales
from actual Android mouse events received by the dedicated page. The page draws the measured
position itself, so capturing the system cursor is unnecessary. It rests for 550 ms before the
measured move. Lost focus, rotation, stale events, clipped movement and intervening input reject
the calibration update. Use system Back to leave the page when done. The API cannot launch the
App/page or grant screen-sharing consent. Never calibrate by clicking a business page, and never
treat the simulated target marker as proof of the physical landing point. Acceleration still limits accuracy.

For a visible system cursor, `android_pointer_calibration` also supports `probe/finish`. The AI reads
the circular cursor in original screenshots; the service calculates the ratios,
so the user does not have to guess horizontal or vertical scales. This is a
two-stage measurement, not automatic computer vision.

1. **Measure a small movement.** Call the tool with `phase: "probe"` and this
   session's latest screenshot `frameId`. It releases held input, prepares ARM,
   makes a small warm-up movement to reveal the cursor, and uses fixed settling
   waits around the measurement. The result contains two original images in
   order: **before** the measured movement, then **after**, plus `probeId`, the
   actual signed `dx`/`dy` counts and the latest after-image `frameId`.
   `direction` is `up-left` (default), `up-right`, `down-left` or `down-right`;
   choose a direction with room to move away from the screen edges. `counts`
   is 16–127 per axis, default 96. The physical emergency stop remains authoritative.

   ```json
   { "phase": "probe", "frameId": "<latest-frameId>", "direction": "up-left", "counts": 96 }
   ```

2. **Read the cursor centers and save.** The AI reads `startX`/`startY` from the
   returned **before** image and `endX`/`endY` from the **after** image, then calls
   `phase: "finish"` with `probeId` and the latest frame from the same session.
   Use original-image pixels, not reduced preview pixels or the initial screenshot
   from before warm-up. The numbers below are illustrative; replace all four with
   the centers actually visible in the returned images.

   ```json
   { "phase": "finish", "probeId": "<probeId>", "frameId": "<latest-after-frameId>", "startX": 800, "startY": 1600, "endX": 704, "endY": 1504 }
   ```

The service derives HID counts per screenshot pixel. It rejects reversed motion,
less than 12 pixels of travel on either axis, and an endpoint clipped at a screen
edge. Do not send other input or take over the mouse between `probe` and `finish`.
A read-only screenshot or `android_control` `wait` may provide a newer frame;
finish still requires the same phone, physical dimensions, rotation and unchanged
input ownership. A probe belongs only to its originating MCP session.

If a cursor is not visible, or the first after-image has not visibly caught up,
observe again with `android_screenshot` or `wait`. Do not replay an already
completed probe movement. If the probe has expired or was invalidated, do not
reuse its measurements. Calibration remains an estimate under mouse acceleration;
recalibrate after changing phones, rotation, pointer speed or mouse settings.
The old `android_calibrate_pointer` manual setter remains compatible, but only
saves supplied scales and does not perform this measurement. Relative move/click,
keyboard and wheel actions still require no calibration.

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
# Optional 15-minute resource observation (default: 120 seconds).
node apps/android-mcp/tools/soak-exe.mjs --duration-seconds 900
```

EXE checks launch with empty PATH and Chinese/space paths, covering first setup,
duplicate launch, same-process reloads, official HTTP/stdio MCP and embedded resources.
The sustained stress fixture uses a loopback phone/ESP; it is not physical-device acceptance.
Its optional `--duration-seconds` accepts 120–7200 seconds and records the fixture EXE's
private/working memory and cleanup. These local fixtures do not measure real-device performance.
Tests use mocked devices plus official MCP clients for stdio and loopback HTTP.
JPEG reception validates dimensions, segment lengths, scans and the complete ending;
PNG adapters remain supported for existing fixtures. Current device results and remaining checks are recorded below.
The retained `tools/preview.ps1` is optional read-only USB/scrcpy diagnostics only;
it does not supply product screenshots or participate in the LAN runtime path.

See the [acceptance record](docs/acceptance.md) for observed results, artifact hashes
and remaining physical-device checks.
