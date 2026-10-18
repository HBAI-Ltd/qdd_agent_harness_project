<p align="right"><a href="README.zh_CN.md">简体中文</a> · <strong>English</strong></p>

# QDD Android LAN screen app

Install this native Android app on the phone. After the user grants Android's
screen-sharing permission, the app streams selectable-quality JPEG previews to the
computer over the same Wi-Fi LAN. The computer's `android-mcp` service separately
requests fresh original-resolution JPEGs for an image-capable MCP client. Keyboard and mouse input remain on
the separate ESP32 BLE HID path.

```text
Android MediaProjection → Wi-Fi LAN MJPEG preview → PC operator
Android MediaProjection → Wi-Fi LAN original JPEG → PC MCP → AI sees the screen
ESP32 BLE keyboard/mouse → Android input
ESP32 encrypted BLE text → selected device IME → focused text field
```

USB is used only for initial APK installation and debugging. Runtime screen
delivery requires neither ADB forwarding nor scrcpy. The app has no accessibility
service, input injection, microphone capture, model API or runtime dependency.

## Build on Windows

The build uses JDK 17+, Android SDK Platform 34 and Build Tools 36.0.0 directly:
`aapt2`, `javac`, `d8`, `zipalign`, and `apksigner`. No Gradle download is needed.
Java sources compile against Android's boot classpath with Java 8 bytecode.
The root npm build command has been verified with Windows PowerShell 5.1;
SHA-256 calculation uses .NET and requires no `Get-FileHash` command.

From the monorepo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./apps/android-screen/tools/build.ps1 `
  -SdkRoot "C:/Android/Sdk" -JavaHome "C:/Java/jdk-17"
```

Replace the sample paths with actual SDK/JDK directories. Valid
`ANDROID_HOME` / `ANDROID_SDK_ROOT` and `JAVA_HOME` are also supported. For a local
configuration, create Git-ignored `apps/android-screen/.local/toolchain.json`:

```json
{"sdkRoot":"C:/Android/Sdk","javaHome":"C:/Java/jdk-17"}
```

Then `npm run build:android:screen` from the root uses that configuration.
Explicit script arguments override it. Each build refreshes generated classes,
verifies APK signing, and writes the APK SHA-256 to `build/manifest.json`.

Output: `apps/android-screen/build/qdd-android-screen-debug.apk`.
The local development signing key stays in `.local/debug.keystore`; generated
files and signing keys are Git-ignored. Keep that key to install future builds
over the same app. This is a development-signed APK, not a published release.

## Install and connect

The updated ESP QR points to its own LAN page, `http://<board-IP>:3334/`.
Scan it to download the APK; after installation, return to the page and open the App.
The App remembers the selected board and shows its Bluetooth guide. It also discovers
a unique board on the same Wi-Fi; scan the intended board if several are present.
The App registers its IP, UUID and projection state with ESP so the PC EXE's automatic
discovery can fill connection settings. If the board IP changes, discovery matches the
selected Bluetooth name instead of silently switching devices. Registration grants no
HID input rights and does not skip Android screen-sharing consent.

If the LAN listener temporarily fails to start, the App retries after intervals
of 1, 3 and 10 seconds, then stops automatic retries. Its retry-LAN button can
recover after the fault clears without reauthorizing an active projection.
A healthy listener and its connections stay intact; network loss or replacement
invalidates older retries. Active projection means capture is running, so also
check the App's LAN connection status and current address.

The Bluetooth guide accepts the controller as ready only when `connected`, `encrypted`,
`bonded` and `ready` are all true. Just Works pairing needs no typed code; confirm the
device in Android's Bluetooth settings. Its `authenticated` flag can remain false:
encryption and bonding do not provide passkey-based MITM authentication.

Install the APK on Android 8+; Android 13 is the current acceptance target.
For an authorized, USB-connected development device:

```powershell
adb -s YOUR_USB_SERIAL install -r ./apps/android-screen/build/qdd-android-screen-debug.apk
```

Open **设备投屏**, connect the phone and computer to the same Wi-Fi LAN,
and read the displayed `http://<phone-private-IP>:8791` address. Configure
`ANDROID_SCREEN_URL` in the computer's `apps/android-mcp/.env`; no connection
code, password or application token is needed. There is no runtime USB requirement.
Guest networks or access-point client isolation may block phone-to-computer LAN
traffic; use a network that permits local peers to connect.

Tap **开始投屏**, then confirm Android's screen-sharing dialog. Notification
permission is optional: denial still proceeds to the separate sharing prompt and
does not repeatedly request notifications. Android 14+ requests the whole display.
When notifications are allowed, the ongoing notification can stop capture; the
**停止投屏** button in the App is always available during capture. See the
[Android notification permission guidance](https://developer.android.com/develop/ui/views/notifications/notification-permission).

Stopping immediately revokes frames. A new session is admitted only after the
capture and encoding workers release the old resources, and needs fresh system
consent. Activity recreation preserves a pending system prompt and the original
three-second monotonic startup deadline. A failed startup cannot permanently
disable the button after recreation, and an old timer cannot clear a later grant.

The app stores a random UUID device identity, its port and the preview quality in private preferences.
The identity remains stable across app restarts. Backups are disabled.

During USB setup, an optional Activity extra can set the port (1024..65535):

```powershell
adb -s YOUR_USB_SERIAL shell am start -n cn.qdd.screenbridge/.MainActivity `
  --ei port 8791
```

Configuration does not bypass the system consent dialog or automatically begin
capture. Stop projection before changing the port. Without extras, the port
defaults to 8791 and persists after configuration.

## Preview quality

Choose **画质** beside the operator's live-picture title. While controlling the
phone, press **Esc** first to make the selector available. Changes apply to the
existing stream and persist on the phone; they do not change Bluetooth pairing
or AI pointer calibration.

| Choice | Profile | Preview short edge | Color | JPEG quality |
| --- | --- | --- | --- | --- |
| 极速（灰度） / Turbo | `turbo` | 360 px | Grayscale | 45 |
| 快速 / Fast | `fast` | 540 px | Color | 60 |
| 标准 / Standard (default) | `standard` | 720 px | Color | 70 |
| 原画 / Original | `original` | Physical display size | Color | 75 |

Previews preserve the aspect ratio and never upscale a smaller display. Only the
preview is downsampled or converted to grayscale. `/frame.jpg`, MCP screenshots
and the image returned after an MCP action always use a newly acquired,
full-resolution color JPEG at quality 75. AI coordinates and human relative
movement remain based on the physical display dimensions. For example, a
1080×2400 phone has a 720×1600 standard preview, while MCP still receives
1080×2400. A quality change does not count as a phone rotation or invalidate
calibration. The 33 ms continuous-capture target stays fixed across all profiles;
actual delivered frame rates still depend on the phone and LAN.

## HTTP contract

The server binds only the current Wi-Fi RFC1918 IPv4 address, never all interfaces.
Accepted peers are RFC1918 IPv4 or loopback. A Wi-Fi address change/loss closes the
old listener and its connections; the app automatically binds the new address and
updates its UI. Update the PC endpoint when the phone's address changes.

`GET /health` returns service state, stable `deviceId`, `model`, `projecting`,
current `rotation` (0..3), frame readiness, `format: "jpeg"`, and
`mimeType: "image/jpeg"`. It also reports `streamPath: "/stream.mjpg"`,
`streamClients`, and the current acquisition limit as `maxFps`.
The device identity is an app-generated UUID, not a hardware
serial or Android ID.

`GET /preview/profile` reads the saved quality. `POST /preview/profile` accepts
`Content-Type: application/json` and exactly one profile field, with a 256-byte
body limit:

```json
{"profile":"standard"}
```

Both return `{"profile":"standard"}` plus `deviceWidth` and `deviceHeight` when
the physical display size is known. The supported values are the four IDs above.
The PC exposes the same setting through its private-LAN `/screen/profile`
endpoint. These requests do not send keyboard/mouse input or grant screen-sharing
consent. Other phone endpoints reject request bodies.

`GET /frame.jpg` requires no authentication and requests a fresh original image
captured after the request arrived, rather than reusing the preview. Success is `image/jpeg`, with these
headers:

| Header | Meaning |
| --- | --- |
| `X-Device-Id` | Same stable UUID as health |
| `X-Frame-Id` | Unique frame UUID |
| `X-Frame-Age-Ms` | Age measured with Android's monotonic clock |
| `X-Captured-At` | UTC ISO capture timestamp |
| `X-Frame-Width`, `X-Frame-Height` | Encoded JPEG dimensions; original dimensions for `/frame.jpg` |
| `X-Device-Width`, `X-Device-Height` | Physical display dimensions for coordinates |
| `X-Preview-Profile` | `turbo`, `fast`, `standard`, or `original`; always `original` for `/frame.jpg` |
| `X-Display-Rotation` | Android display rotation, 0..3 |

`GET /stream.mjpg` opens one continuous HTTP response with
`Content-Type: multipart/x-mixed-replace; boundary=qdd-frame`. It requires no
authentication. Each genuinely new frame is sent once on that same connection:

```text
--qdd-frame\r\n
Content-Type: image/jpeg\r\n
Content-Length: <JPEG byte count>\r\n
X-Device-Id: <stable UUID>\r\n
X-Frame-Id: <frame UUID>\r\n
X-Frame-Age-Ms: <age at send>\r\n
X-Captured-At: <original UTC acquisition time>\r\n
X-Frame-Width: <width>\r\n
X-Frame-Height: <height>\r\n
X-Device-Width: <physical display width>\r\n
X-Device-Height: <physical display height>\r\n
X-Preview-Profile: <turbo|fast|standard|original>\r\n
X-Display-Rotation: <0..3>\r\n
\r\n
<exact JPEG bytes>\r\n
```

The response has no total content length and is delimited by connection close.
Parts use exact `Content-Length`, so clients must not scan JPEG data for boundary
text. Stopping capture ends the stream; a new permission session requires a new
connection. A quiet source does not repeat the previous frame or refresh its
timestamp. `/frame.jpg` supplies fresh original-resolution MCP and diagnostic captures.

Capture uses `ImageReader` RGBA, strips row padding, and encodes the selected preview profile,
at most one frame every 33 ms (about 30 frames per second) while a stream is connected, or five without a
stream. These are acquisition limits, not a guaranteed device frame rate.
Packed RGBA buffers copy directly into the bitmap; padded buffers reuse one row
view and scratch buffer without allocating a new view for every row.
Original-resolution JPEGs are encoded on demand for `/frame.jpg`; there is no PNG encoding. Connected streams target
33 ms even on static screens, removing the old 500 ms idle downgrade. Two fixed
ImageReaders alternate surfaces on the same VirtualDisplay. Only one forced capture
can be pending, preventing repeated surface swaps from starving composition.
An independent JPEG worker uses two fixed bitmaps and keeps at most one latest pending
image; old pending images are replaced instead of queued. Pixel/JPEG output buffers
are reused, while each published frame owns its encoded bytes. Acquired producer
buffers close before JPEG encoding. Geometry/permission changes reject old worker
publications. Without a continuous stream, individual snapshots use a lower capture
budget. Actual timing depends on scheduling, composition, encoding and LAN throughput.
Only an actually acquired image gets a new frame ID and capture timestamp;
requests never renew an old image's timestamp. Physical capture and MCP images retain
the original dimensions; preview profiles only change their encoded output. `/frame.jpg` returns **503** for stopped capture,
an unavailable fresh original capture, or frames older than three seconds. Unknown routes,
including the former `/frame.png`, return 404; unsupported methods return 405.
Responses disable caching.

HTTP parsing is limited to 8 KiB / 34 headers. Short requests use two worker
threads, four queued connections and a three-second total deadline. Streams use
two separate workers, with at most two connected viewers and six total sockets.
Every stream write has a two-second deadline; a slow viewer is disconnected.
There is no per-viewer frame queue: after a write, the newest frame is selected.
Client disconnect, capture stop, server close and Wi-Fi change release streaming
resources. Only `/preview/profile` accepts a JSON request body; no remote input commands exist.

Capture holds a Wi-Fi performance lock: high-performance on Android 13 and earlier,
low-latency on Android 14+. Stop, failed startup and destruction release it. Only the
normal `WAKE_LOCK` permission is added; Wi-Fi switches and permanent power settings
are unchanged. `wifiLockRequestedMode` and `wifiLockHeld` report the requested mode
and API ownership, not proof of a physical throughput increase.

Run `npm test --workspace @qdd/android-screen` for host Java/socket regressions.
They compile the production HTTP server and frame store with host-only Android
clock/JSON stand-ins under `tools/tests`, use real localhost sockets and JPEG
fixtures, and access no phone, ADB or BLE. Results cover continuous delivery,
freshness, latest-frame selection, stream limits, slow-client cleanup, stop,
rotation metadata and server shutdown. `ProjectionLifecycleTest` and
`CaptureConsentTest` also cover blocking restarts during resource cleanup, stale
callback isolation, notification denial, Activity recreation and service-start
wait recovery. Three pixel regressions cover packed buffer reuse, padded rows and
invalid layout rejection. They do not establish Android streaming frame rate or
phone resource usage; those need a new installed-build test.

## Pointer calibration without a captured system cursor

After starting screen sharing, manually tap **打开指针校准页** in the App. This full-screen
page receives actual mouse events and draws their measured coordinates into ordinary
MediaProjection output. It needs no accessibility, injection or overlay permission. The PC MCP
can measure with `android_pointer_calibration phase: "auto"`; use system Back to leave afterward.

Read-only private-LAN `GET /pointer/calibration` returns `active`, `deviceId`, `sessionId`, physical
`width/height`, `rotation` and `point: {x,y,sequence,ageMs}`. Fractional coordinates come from Android
mouse-event `getRawX/getRawY`; without a valid event, `point` is null. Lost focus/background invalidates
the session and point, and re-entering creates a fresh session. HTTP cannot launch the page or inject
events. Identical images cannot establish gain when the system cursor is absent, and simulated target
markers do not prove actual pointer positions.

## Device Chinese Input

Enable and select **Device Chinese Input** in Android once. Text then travels through encrypted
ESP BLE to the current input method and is submitted with `InputConnection.commitText` to the
focused editor. Keep this IME selected for continuous use; after choosing another keyboard,
select it again. No clipboard, accessibility service, or ADB input is used.

Follow the current prompt in the App's **Device Chinese Input** card:

1. Allow Nearby devices access on Android 12+ and select the current QDD controller already
   paired in Android Bluetooth settings.
2. Initially open **Enable device input method**, enable it in system settings, return to the
   App, and press **Select device input method**.
3. Select Device Chinese Input in the system picker, return to the target App, and focus an
   editable field.

The App distinguishes disabled, unselected, unfocused, and connection states without asking
to repeat completed steps. The user confirms enablement and selection in system UI; the App
does not silently modify the default keyboard. Use the system picker from the IME panel or
App to return to an everyday keyboard. Screen sharing still provides visual confirmation.
Only the device IME owns the text GATT connection; the projection service no longer starts a
competing clipboard receiver.

Each request allows at most 512 UTF-8 bytes, including Chinese, emoji and mixed ASCII, but no
NUL. Editors can filter text or impose length limits: `accepted` only means `commitText`
accepted the request, not that the App displayed or saved it. Inspect the real phone image.
Do not blindly resend after missing acknowledgements, timeout, or cancellation. Text is not
stored in preferences, files, or logs. Locking, losing the editor, changing controller,
disconnecting, or destroying the IME revokes readiness; late callbacks cannot revive old work.

The service UUID is `9bded201-39ba-4a19-8ff7-25c9d00a0001`; ESP indication ends in `0002`
and encrypted phone writes in `0003`. BLE packets use version byte **1**; remaining integers
are little-endian:

| Direction/type | Body |
| --- | --- |
| ESP→phone `01 BEGIN` | id u64, editor epoch u32, UTF-8 length u16 |
| ESP→phone `02 DATA` | id u64, byte offset u16, bytes |
| ESP→phone `03 COMMIT` | id u64, editor epoch u32 |
| ESP→phone `04 CANCEL` | id u64 |
| Phone→ESP `81 READY` / `83 NOT_READY` | editor epoch u32 |
| Phone→ESP `82 ACK` | id u64, status u8, editor epoch u32 |

ACK 0 is accepted, 1 rejected, and 2 uncertain. Repeated COMMIT returns the cached result
without another submission. A changed focus, receiver identity, or epoch prevents submission;
clipboard v2 packets cannot confirm v1 input. Pure Java protocol, session, and preparation
state tests run with `npm test --workspace @qdd/android-screen`. These Host checks and APK
signature validation do not replace device testing of system setup and actual Chinese text.

Platform references: [Android IMEs and system selection](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method),
[InputConnection.commitText](https://developer.android.com/reference/android/view/inputmethod/InputConnection#commitText(java.lang.CharSequence,int)).

## Validation boundary

The four-profile behavior is covered by host regressions; actual phone frame rates
require acceptance of the installed APK identified in `build/manifest.json`.
The device measurements below belong to earlier builds and do not establish
performance for the current preview profiles.

The build script compiles all Java and resources and verifies APK signatures and
package permissions. It does not install, start, or grant permissions on a phone.
The optimized APK SHA-256
`d55e935bb6a36b108fe8e67a768c00c723f1073d394f9ab1135984ceb9e540d5`
passed build/signature verification, 10 host socket regressions and three pixel
regressions. On 2026-10-17 it was installed over the existing OnePlus 8 app after
checking its hash against `build/manifest.json`; the user granted screen sharing
again. Installation and consent do not establish a sustained frame rate. The earlier APK SHA-256
`0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`
was installed over the previous version on a OnePlus 8 (IN2010), and the user
granted Android screen-sharing permission. A real 25-second test received 58
original-resolution 1080×2400 JPEG frames through one `/stream.mjpg` connection,
with 58 distinct source frame IDs, 32 distinct image hashes and zero errors.
Maximum received frame age was 617 ms. The busiest one-second interval contained
12 frames; this is a measured peak, not a sustained frame-rate guarantee. See the
[current streaming device record](../android-mcp/build/device-tests/oneplus-stream-v5.json).

The same test timed 30 reads from the PC's already-received frame cache. Its
maximum of 0.0301 ms measures only that local cache method; it does not measure
screen capture, network transfer, a complete MCP call or end-to-end display latency.

Historical single-image acceptance belongs to APK SHA-256
`94458e41878fdaac309e6103ab0080504aa1e46a48e557e947a38f790539da89`:
30/30 token-free LAN `/frame.jpg` requests passed after 16 seconds of idle
wallpaper, with approximately 193 KiB images, 240 ms median / 589 ms maximum
capture latency, and 703 ms median / 1260 ms maximum final frame age. Those
figures describe the previous build and are not current streaming measurements.
See the [historical single-image record](../android-mcp/build/device-tests/oneplus-wallpaper-jpeg-v4.json).

Rotation (including 180 degrees), manual capture stop and fresh system consent
after stopping, and Wi-Fi loss/address changes have not yet been verified on the
phone. Protected Android windows may be black.
