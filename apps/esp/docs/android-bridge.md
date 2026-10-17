<p align="right"><a href="android-bridge.zh_CN.md">简体中文</a> · <strong>English</strong></p>

# Device Controller Wi-Fi/USB to BLE keyboard and mouse bridge

The computer communicates with AI Passport over local Wi-Fi TCP or its USB Serial/JTAG CDC port.
AI Passport acts as a bonded BLE HOGP keyboard and relative mouse for Android.
The Android phone runs the separate Device Screen Sharing App and shares its screen
with the computer over the local Wi-Fi network. Pointer calibration, gestures,
text mapping and MCP run on the computer. Phone USB is only used for initial
installation or diagnostics. See the monorepo's `apps/android-screen/README.md`
and `apps/android-mcp/README.md`. This firmware contains no accessibility
executor, AirPlay receiver, Wi-Fi hotspot or cloud credential.
Live previews offer turbo grayscale, fast, standard and original presets. MCP requests a newly acquired original-size JPEG on demand.
Neither the phone App nor the PC MCP/operator connection requires an application
token or connection code. Android screen-sharing consent and the BLE system's
six-digit pairing PIN remain; a previously bonded phone need not pair again.

The reference [esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent)
uses ESP32-S3 native USB HID and AirPlay. ESP32-C3 USB Serial/JTAG is a fixed
serial/debug peripheral, so this board uses BLE HOGP for input instead. BSP
drivers remain from FoloToy; the application and screen are independently
implemented. The application registers its HOGP service using public ESP-IDF
NimBLE GATT APIs. It deliberately does not instantiate `esp_hidd_dev_init`:
ESP-IDF 5.5.3's private HID listener asserts on a failed CONNECT event, and there
is no public API to safely remove that listener. The application's sole GAP
callback handles failed CONNECT by resetting state and returning before any
connection lookup; no private HID listener is registered.

The [HOGP ICS tables 3 and 4](https://files.bluetooth.com/wp-content/uploads/2024/10/HOGP.ICS.p8.pdf)
require Battery Service, Device Information Service, and PnP ID. The GATT
database provides Battery Service (`180F`,
readable Battery Level `2A19`) and Device Information Service (`180A`, readable
PnP ID `2A50`). Battery reads use the presentation task's cached 0..100 sample;
the GATT callback never performs I2C. When the cache is unavailable, the read
returns an ATT error rather than inventing a percentage.

`menuconfig` → **QDD Android HID bridge** configures PnP vendor-ID source
(1 Bluetooth SIG / 2 USB-IF), authorized vendor ID, product ID, and version.
The development defaults are source **1**, vendor **FFFF**, product **0000**,
version **0100**: an explicitly unknown development sentinel, not an allocated
vendor identity. Use only identifiers assigned to you or that you are authorized
to use; do not borrow another manufacturer's ID. This prototype does not claim
Bluetooth qualification. The source defaults are also in `sdkconfig.defaults`.

## Connect and operate

1. Run `npm run build:android:screen` before `npm run build:esp` from the monorepo root.
   Firmware embeds the signed APK; CMake verifies its SHA-256 against `build/manifest.json`
   and fails if the APK is missing or mismatched. The gate builds fresh
   `sdkconfig.defaults`, including HID, Secure Connections, and persistent bonds.
   An existing ignored development `sdkconfig` can override those defaults;
   use a separate configuration/build directory for incremental work.
2. Flash only after explicit device authorization under [AGENTS.md](../AGENTS.md).
   A segmented flash with a compatible partition table preserves NVS. The
   merged full image can reset NVS, including Bluetooth bonds.
3. Install the phone screen-sharing App. Connect Android and the computer to
   the same Wi-Fi LAN. Passport can use USB serial to the PC. For Wi-Fi control,
   select Settings with UP/DOWN on the status screen, confirm, then select Wi-Fi and enter its password with the visible keyboard.
4. In Android Bluetooth settings, select `QDD-Passport-XXXX`. A new device opens
   a two-minute pairing window. Select phone pairing in Settings to open it again. Enter the six-digit
   code displayed on Passport using the Android pairing dialog.
5. Set the computer's `ESP_HOST` to Passport's displayed IPv4 and `ESP_TCP_PORT`
   to its port (default 3333), then start the bridge. Leave `ESP_HOST` blank to
   explicitly use `ESP_PORT` over USB. It sends `PING` every 300 ms.
   No separate manual enable action is needed. The Chinese screen shows that
   remote control is available after authenticated, encrypted,
   bonded BLE input is ready, Android subscribed to active mouse and keyboard
   notifications, and the computer heartbeat is fresh.

| Device input/page | Effect |
| --- | --- |
| Home UP/DOWN | Select Stop / Cancel stop or Settings. Boot and returning home default to Stop. Navigation executes no input action. |
| Home OK click | Execute the selected item: immediately latch stop and release input, locally clear a stop, or enter Settings. The PC cannot unlock. |
| Settings and ordinary pages | UP/DOWN select, short OK enters, and an explicit vertical Back entry returns. The key guide and phone pairing are in Settings. No hold is required. |
| Password keyboard | Retain row/character selection and OK typing; hold OK opens the vertical completion menu. |

The independent 240 x 320 Chinese screen prioritizes emergency stop, computer
connection, phone connection, then availability. A connected computer means
the selected controller has a fresh PING lease (at most 1500 ms), not merely a
plugged USB cable or Wi-Fi association. Battery stays at the upper right;
unavailable data shows `--%`. The bottom identity card shows the Bluetooth name; the connection guide shows
the network address. The six-digit pairing PIN appears only while locally visible. Errors use fixed Chinese text.

Product labels are Device Controller, Device Screen Sharing and Device Console. The dark `#d4380d` card UI has three fixed, text-free, theme-colored right-edge markers with rounded caps, matching UP, DOWN and OK. The top/bottom markers reach four-pixel edge margins. Ordinary choices and Back entries
are vertical. Menu input is inhibited and old input released; leaving menus never clears a stop
or adds a manual enable workflow. Licensed 14/20 px CJK subsets are described in
[assets](../assets/README.md). The markers/keyboard are custom-drawn to bound RAM; unchanged samples
allocate and redraw nothing. The key guide follows the actual tall gray enclosure, top strap opening, upper-left display, lower-right diagonal speaker grille and silver right-side buttons. Connector lines map the keys to their navigation actions. It keeps an explicit Back entry. The original demo remains unlinked. Bonds, protocol, USB detection
and heartbeat policy remain unchanged.

### Wi-Fi setup on the device

The first connection follows six steps: Wi-Fi → scan/install → wait for App → phone
Bluetooth → start the PC EXE → operate. Completed steps are skipped. Home defaults to Stop; select with UP/DOWN and confirm to execute. Settings inhibit phone input. An unconfigured board opens its network list and
screen keyboard automatically. A lost saved network retains its profile and retries.

The QR code and `http://<board-IP>:3334/` open the board's Chinese connection page.
The scan and installation-wait screens show both options: scan the code, or enter
the displayed IP and port in the phone browser to download the App. The phone,
computer, and ESP must share the same local network; the landing page highlights
this requirement. This setup page is available only within that LAN.
The phone downloads `/qdd-remote.apk`; after installation, the page's open-App link
passes the board address to the App. The App can also discover a unique board on
the LAN and shows its existing Bluetooth name, without removing bonds.
On the PC, start Device Console and use **Find automatically** in connection settings to
fill the phone address, identity and board address, then save. Multiple boards
require selecting the intended target instead of adopting the first reply.

HTTP 3334 exposes `/api/status`, `POST /api/phone` and `POST /api/pc`; UDP 3335
answers `QDD-DISCOVER/1`. Phone/PC registration expires after 15 seconds and only
updates the guide; it grants no input rights. The phone page does not access the PC's local port; PC connection settings determine local and LAN operator access. The APK resides in
application Flash, preserving the existing NVS, PHY partitions and Bluetooth bonds.

The board supports 2.4 GHz Wi-Fi. The list shows up to eight networks, sorted by signal strength, with page
numbers, Rescan and Back. UP/DOWN select; OK enters. A long name is shortened
only for display. Unsupported glyphs use the network number and BSSID suffix;
the original valid UTF-8 SSID (at most 32 bytes) is retained for connection.
Hidden networks require the optional USB diagnostic tool.

The six-column keyboard shows four rows per page and all 95 printable ASCII
characters across four pages: digits, lowercase, uppercase, punctuation and a
clearly labeled Space. UP/DOWN select a row; OK enters that row; UP/DOWN select
a character; OK types it and returns to row selection, remembering the position.
Hold OK for the vertical Connect/Continue/Delete/Back menu. Continue preserves input. Ordinary
Wi-Fi/menu pages have a selectable Back entry, eventually returning home from the device menu.
Delete removes one complete UTF-8
character. Passwords remain masked and never enter logs or protocol status.
WPA2/WPA3 passphrases require 8..63 bytes, or exactly 64 hexadecimal PSK bytes;
open networks allow an empty password. Enterprise login is not provided.

Setup atomically inhibits all nonzero HID reports and PC ARM for its entire
lifetime. UP/DOWN navigate on all ordinary pages; home defaults to Stop and
short OK executes the selected item. Exit clears old held input and never clears a physical stop lock.
Successful connection returns home and shows the address. A ready secure phone
and fresh controller heartbeat permit the next input without manual resume.
The single `qdd_wifi/profile` NVS blob is independent of Bluetooth owner bonds;
failed connections never erase either profile or bonds.

For optional USB diagnostics, create ignored `apps/esp/.wifi.local.json` with
`port`, `ssid`, and `password`, then run `start-esp-wifi.cmd` from the monorepo
root. `--config PATH` chooses another local JSON; `--check` validates without
opening USB. Manually stop any serial service first. The tool never kills or
restarts it, prints no credentials, pauses before setup, and never enables input.

### Sole controller and reconnects

TCP listens only on its assigned private IPv4, port 3333 (configurable through
`CONFIG_QDD_TCP_PORT`). It accepts one peer; extra peers are closed. USB and TCP
share the same bounded line protocol below. The first PING claims ownership.
Only that source may renew the lease or mutate input; the other source may read
STATUS but receives `CONTROL_BUSY` for PING/ARM/PAUSE/RELEASE/input. TCP pairing
management returns `USB_ONLY`. Setup rejects new owners and ARM with `CONFIGURING`.

USB presence requires 50 ms of sustained loss before disconnecting, filtering millisecond
SOF-monitor flicker that could otherwise clear ownership or partial input lines. Startup
without USB, sustained loss and clock regression still stop control; recovery requires
a new valid PING. This confirmation does not extend the 1500 ms heartbeat lease or delay
the immediate local stop confirmation.

Socket closure, Wi-Fi/address epoch change, USB-owner disconnect or a PING age
above 1500 ms releases and pauses, then clears ownership and closes a TCP owner.
A new TCP connection
cannot inherit the old stream, lease or armed state, even at the same IP.
Replies are not queued or retried; a partial/failed write closes that TCP peer.
Wi-Fi reconnect uses bounded backoff and never falls back to USB automatically.
A new owner must send a fresh PING; ready secure BLE input then accepts new
commands directly, while a physical stop lock continues to reject them.
This hackathon LAN protocol has no application token or TLS; use the intended
local network. USB remains an explicit fallback, not a second concurrent controller.

Optional USB provisioning uses separate `QDDNET/1 <id>` lines: `WIFI_STATUS`,
`WIFI_SSID <base64 UTF-8>`, `WIFI_PASS <base64>` (`-` for empty), `WIFI_SAVE`,
`WIFI_RETRY`, `WIFI_CLEAR`. Mutations require paused input and no TCP owner;
native setup also excludes USB mutations. SSID and password must both be staged
before SAVE. Replies expose only configured/connected/IP/port, never credentials.
CLEAR deletes only the Wi-Fi profile key. TCP always rejects these operations.

Pairing outside the window is rejected for unknown peers. Reconnecting a stored
peer never restores held inputs. Once ready, it accepts fresh controller commands
without a manual enable step. The firmware stores one owner bond and never erases
NVS, evicts a bond, or silently accepts repeat pairing. If Android forgets its
keys or another owner is required, explicit bond maintenance is necessary;
opening the pairing window does not erase existing owner keys.

## USB/TCP protocol: QDDHID/1

ASCII lines end in LF; CRLF is accepted. Maximum buffered line length is 128
bytes, including an optional CR and excluding LF. Empty lines are ignored.
The request id is a decimal integer from 1 through 2147483647.

```text
QDDHID/1 <id> <OP> <args>\n
QDDHID/1 <id> OK <status JSON>\n
QDDHID/1 <id> ERR <error code>\n
```

Every nonempty request line has exactly one reply. Invalid or oversized lines
without a valid parsed id use reply id `0`; oversized input is drained through
LF before parsing resumes. Embedded NUL, non-ASCII input, overflow, unknown
operations, extra/missing arguments, and out-of-range numbers are rejected.
Normal ESP-IDF boot logs do not begin with `QDDHID/1` and are not protocol replies.
After successful startup, ESP-IDF runtime logging is muted to prevent logs from
interleaving with protocol replies on the same CDC port.

| Operation | Arguments and behavior |
| --- | --- |
| `PING` | Refresh the computer lease. Only PING refreshes it. |
| `STATUS` | Read current state. |
| `ARM` | Optional legacy enable command. Require unlocked, connected, authenticated, encrypted, bonded, subscribed to both active mouse/keyboard reports, and a PING at most 1500 ms old; release old inputs first. Normal input commands apply the same checks automatically. |
| `PAUSE` | Internal release/reset command; preserve any physical lock. The next valid input does not require a separate ARM. |
| `RELEASE` | Release all mouse buttons, keys/modifiers, and Consumer usage; preserve armed and physical-lock state. |
| `MOVE dx dy wheel buttons` | Send a relative mouse report. dx/dy/wheel each -127..127; buttons is a 0..7 bitmask for left/right/middle. |
| `KEY modifier keycode` | Send one USB HID keyboard usage (not an Android keycode); modifier 0..255 and keycode 0..255. Keycode 0 releases all keys and modifiers. |
| `CONSUMER usage` | Send one 16-bit HID Consumer usage, 0..65535; 0 releases it. AC Home is 547 (`0x0223`), AC Back is 548 (`0x0224`); Android mapping requires device verification. |
| `PAIR` | Local USB setup only: pause, release, and open a two-minute pairing window. Preserves the physical stop lock. |
| `PAIR_STATUS` | Local USB setup only: read pairing-window/passkey state without changing it or renewing the heartbeat. |

All OK replies use the same fixed JSON fields:

```json
{"v":1,"connected":true,"encrypted":true,"armed":false,"locked":false,"bonded":true,"ready":true,"name":"QDD-Passport-1234"}
```

Only `PAIR` and `PAIR_STATUS` append `pairingOpen` and `passkeyVisible` to this
full status. They include numeric `passkey` only while the pairing window is
open and a generated passkey is visible. `PING`, ordinary `STATUS`, errors,
and all other replies never include the code. These USB setup operations are
for a local initialization script and are not exposed as MCP agent tools.
Display-only MITM pairing and the device's physical stop lock remain active.

Errors are `BAD_COMMAND`, `LINE_TOO_LONG`, `LOCKED`, `NOT_CONNECTED`,
`NOT_AUTHENTICATED`, `HID_NOT_READY`, `HEARTBEAT_EXPIRED`, `HID_SEND_FAILED`,
`CONTROL_BUSY`, `USB_ONLY`, or `CONFIGURING`.
`ready` requires notification subscriptions for both keyboard and mouse in the
active Report/Boot protocol. Encryption alone does not imply readiness. Losing
either subscription disarms; switching protocol or suspending HID also disarms.
Consumer notifications do not block ARM, but a nonzero Consumer usage requires
its own subscription. Neutral releases without a subscribed recipient are no-ops.
OK means the report was accepted by the local BLE stack, not proof that the
target Android application acted on it. Failed sends disarm and release input.
Input reports are short and immediate; no firmware gesture or typing queue
can continue after a stop. The computer sequences tap, drag, swipe, and text.
Keyboard characters depend on Android's active physical-keyboard layout;
Unicode text is not transmitted by this protocol.

Active-controller disconnection, missing PING for more than 1500 ms, loss of BLE security,
or BLE disconnection disarms control and clears held input. A disconnected
transport cannot deliver a release to Android; the host must clear disconnected
HID state, and the firmware sends neutral reports after secure reconnection
before accepting fresh input. Reconnection never replays held inputs or clears
a physical stop lock; a new valid input can activate control without manual ARM.

## Validation

`tests/test_qdd_hid.c` exercises the pure C parser, every stream split point,
multiple lines in one read, overflow draining, invalid input, numeric bounds,
report bytes, heartbeat deadline, physical lock, disconnect/reconnect, release
failure, and reply framing. It runs in `tools/validate.sh --static` alongside
the retained BSP/demo host tests.
`tests/test_qdd_control.c` covers source isolation, ownership, private addresses
and heartbeat boundaries. `tests/test_qdd_net_config.c` covers strict local
provisioning parsing. `tests/test_qdd_setup_model.c` reaches all 95 keys through
the actual focus model, UTF-8 byte bounds/deletion, scan/back paths and secret wipes.
`tests/test_qdd_ui_model.c` covers Chinese state priority, link versus heartbeat,
lease boundaries, PIN visibility, expiring notices and actual confirm-key policy.
`tests/test_qdd_fonts.py` audits inventory, generated cmap coverage and bindings.
The optional native-host project `tests/qdd_ui_host/` uses actual LVGL 9.5 glyph
lookup with missing-glyph negative cases, checks every displayed label's width
and bounds, and captures seven home plus ten setup RGB565 screens with the board's corner mask.
It uses the same 24 KiB LVGL pool and 240 x 20 draw buffer; 100 unchanged refreshes
produce no flushes or additional live allocations. Twenty enter/exit cycles
retain the same live allocation count and bounded allocator alignment cycle. These are host checks,
not physical-panel or BLE runtime-heap acceptance.
`tests/test_qdd_hid.c` also covers separate Report/Boot CCCD masks, delayed subscription,
partial subscription, unsubscribe while armed, Consumer readiness, and reconnect
clearing all subscriptions. `tests/test_qdd_ble_contract.py` checks the failed
CONNECT early-return path and absence of the SDK private listener entry point.
It also checks required BAS/DIS characteristic declarations and cached battery
access; the C tests verify seven-byte little-endian PnP encoding and ID sources.

Actual device acceptance still requires the specific Android phone: encrypted
passkey pairing, reconnect, mouse buttons/wheel, held-key release, physical stop,
USB removal, computer crash/heartbeat expiry, Android screen rotation and
pointer calibration, text layout, Consumer Home/Back, and battery/rendering.
Compilation and host tests cannot establish those results.
