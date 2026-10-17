<p align="right"><a href="acceptance.zh_CN.md">简体中文</a> · <strong>English</strong></p>

# Android LAN screen and input acceptance

## User device feedback and current validation boundary

2026-10-17: The user explicitly reports that downloads work on the real device and requests that
download investigation and speculative changes stop. This record follows that actual-use feedback.
Earlier PC curl/Node and ADB-launched phone curl probes timed out or truncated; those results only
describe the specific probes and do not establish a failure in the user's browser/App download flow.
Their original logs remain for traceability. No further download changes or tests will follow from these probes.

## v25 Cold-start diagnostic guard — flashed, cold-state observation passed

The v24 startup diagnostic fault was located in a Wi-Fi SDK query before initialization.
This change only gates the four SDK getters on `s_initialized && s_started`; inactive states
return `NOT_INIT/NOT_STARTED` without calling them. UI, startup guide and fonts remain at v24,
with no configuration reset or erase. Cold/stopped continuous-diagnostic regressions failed before
the guard and now PASS. The final firmware gate and matching archive verification PASS; log
`apps/esp/build/guide-pair-v25-build.log`. COM5 App-only flashing wrote 1,659,920 bytes at
`0x10000`, hash verified, preserving NVS/PHY.

Device tests: PASS only for the 20s startup/diagnostic observation. All 11 read-only requests
replied (9 DIAG and 2 `WIFI_STATUS`), with `faults=[]`, normal cold-state `NOT_INIT` responses
and stable `heap=75060/min=74988`. No panic or reboot was observed in that window; the queries
did not start the Wi-Fi SDK, write NVS or send HID input. Evidence:
`apps/esp/build/guide-pair-v25-startup.json` and its serial log. Physical buttons, pairing visuals
and complete onboarding remain unaccepted. The reason for current `configured=false` is unknown;
neither restored Wi-Fi nor retained configuration is claimed, and the v22 persistent-link failure
remains valid. The PC service restarted with health `status=ok`, buildId `7c769d5e10e2f43fa749`.
Its sidecar still explicitly selects LAN `192.168.100.167:3333`; the unconfigured board is not
claimed reachable.

Merged SHA-256: `0fb2551229515213e33788fab6b6ecbe4bdeab72f1e9bad4df437c862f51c4e0`.
App SHA-256: `4d69872dea1a7f637e59a9f3f1c684f7d9f6cf2e9a5d88bda3078ab6d16055f7` (1,659,920 bytes).
ELF SHA-256: `b4107fe50f3e77fa7433bfd35b3efb3bddd55a13e3d1f00f52e03a1a41ab5453`.
Archive: `apps/esp/build/firmware/0fb2551229515213e33788fab6b6ecbe4bdeab72f1e9bad4df437c862f51c4e0/manifest.json`.

## v24 Bluetooth settings feedback and initial key guide — flashed, startup diagnostics failed

2026-10-17: Bluetooth settings now distinguish an open pairing window, waiting for the phone,
secure connection and HID readiness in real time, hiding expired pairing codes. Confirmation
shows a 600ms button outline and 3s acknowledgement; opening a window does not imply successful
pairing or change BLE security requirements. With no saved Wi-Fi, including after reset, the
physical-key illustration appears before step 1. Short OK enters the original first step without
scanning. The key guide opened through normal Settings retains its existing Back behavior.

- Host checks: UI-model/setup C, actual-LVGL `--pair` / `--intro` and three font checks PASS. Fonts contain 222 non-ASCII and 95 printable ASCII characters. These are focused host checks.
- Build: PASS; final firmware compilation and matching artifact verification succeeded.
- Flash: PASS; COM5 App-only write of 1,659,840 bytes at `0x10000`, hash verified.
- Device tests: FAIL (startup diagnostics). `WIFI_STATUS` reported unconfigured; `WIFI_DIAG` at 4s and 10s each triggered a `Load access fault`. Evidence: `apps/esp/build/guide-pair-v24-startup.json` and its matching log. The matching ELF decodes to `current_task_is_wifi_task → wifi_api_unlock → esp_wifi_sta_get_rssi → qdd_wifi_diagnostics:92`, supporting the uninitialized-SDK query finding. The reason Wi-Fi is unconfigured remains unknown; no NVS reset or erase followed from that observation.
- Unverified: physical pairing feedback and complete first configuration remain unaccepted. The earlier Wi-Fi stability issue is not claimed fixed; v22 FAIL remains below.

Merged SHA-256: `ed18797d76644671e2a7f6ce515eda55e526473047946a9f9822a3630ca72194`.
App SHA-256: `afe83d2b8b1da0f46e7c3f76a08f79704da0c0870f5e85c10c5c7263ffd9b11a` (1,659,840 bytes).
ELF SHA-256: `52eec88be5037b2a8c2bda1ade46674c21f6dec259f401a9cfe4747b88d8e488`.

## v22 LAN-first setup and device discovery — flashed, continuous control still fails

2026-10-17: First setup defaults to LAN, leaving the board IP empty for the actual address and
defaulting the control port to `3333`. The QR/App-download guide uses `3334`. Packaging no longer
clears `ESP_HOST`; `wx` initialization only creates an absent sidecar when a real LAN address is
available, preserving existing local choices. Complete UDP status is accepted directly after private
source/IP/board-URL-host/schema checks; HTTP supplements known hints only. The same socket/address
set sends three neutral discovery requests within the original 1,400ms window, deduplicates results
and cancels resend timers on completion/abort. No control-action retry, automatic USB fallback or
longer HID timeout was added.

| Check | Result and boundary |
| --- | --- |
| Focused PC checks | 27 PASS covering LAN defaults, sidecar preservation, direct UDP status and first-packet loss/cancellation cleanup |
| Final EXE | 12 offline scenarios PASS, including official MCP SDK, stdio, first configuration and reload. Log `apps/android-mcp/build/exe-v22-final-tests.log` explicitly records `realDeviceInput=false`; this is not real-device input acceptance |
| ESP Build / Flash | Firmware build/archive and COM5 App-only flashing PASS: 1,658,080 bytes at `0x10000`, written-data hash verified, preserving NVS |
| Current local configuration / discovery | Sidecar selects `ESP_HOST=192.168.100.167`, TCP `3333`; the final service runs over LAN with `/health` reporting `ok`. Another actual `/desktop/discover` call finds the board with `phone:null` and disconnected Bluetooth; the previous temporary USB configuration is no longer selected |
| Raw TCP heartbeats | 60/60 PING replies succeeded, maximum 1,117ms. Evidence: `apps/android-mcp/build/tcp-v22-raw.json`. This does not replace MCP persistent-link acceptance |
| Additional TCP bridge trace | 15/15 `STATUS` calls succeeded, maximum 1,123ms excluding the 1,611ms cold handshake, with 81 replies. During close cleanup, PING 82 / RELEASE 83 / PAUSE 84 received no ACK before socket close. Evidence: `apps/android-mcp/build/tcp-v22-bridge-trace2.json`. This does not establish stability |
| Actual official-MCP queries | FAIL: sample 1 still reports `ESP32 PING acknowledgement timed out`. Evidence: `apps/android-mcp/build/mcp-v22-lan-diagnostics-status.json`. Continuous-control stability has not passed |
| 90s diagnostics | No observed panic, zero OOM/transmit-failure counts and `up=1`. Evidence: `apps/esp/build/lan-v22-diagnostics.json`. The first 3001 reply shares a line with a boot fragment but was received, so UART reply loss is not established |
| Phone and Bluetooth | Final health at `192.168.101.46` reaches the 3s timeout, ICMP is 0/20, ADB lists no devices, and Bluetooth is disconnected. Complete real-device control cannot be accepted; these observations do not establish a router fault |
| Device tests | PARTIAL: discovery and some neutral transfers pass, while MCP continuous-link stability is FAIL. Phone-screen/BLE-input end-to-end acceptance remains incomplete; a finished-product PASS is not claimed |

PC EXE buildId: `7c769d5e10e2f43fa749`.
EXE SHA-256: `51d390cc57ffc8e33285e7014a4f403414d168d9daa26d794a0da0683a26e11d` (93,346,816 bytes).
ESP merged SHA-256: `ea35050804fcdf29c69d5f2ab94646d8a1fb8d4ccab7d1df2c23f1df96ca5ddd` (1,723,616 bytes).
App SHA-256: `4f52e2d90da9e8af7af4d2cadea4e39b138b7d7f7c740026668de70ce37b6c14` (1,658,080 bytes).
ELF SHA-256: `7c532c87099486e20f3baf911a2a39948f93728aadb9626ea2b00af1857d8c63`.
Archive: `apps/esp/build/firmware/ea35050804fcdf29c69d5f2ab94646d8a1fb8d4ccab7d1df2c23f1df96ca5ddd/manifest.json`.

## v21 Heartbeat acknowledgements and completed-guide state — flashed, COM5 neutral link passes, Wi-Fi repeat fails

2026-10-17: The PC bridge reproduced a single lost timer-PING reply suppressing later heartbeats.
It now sends up to four outstanding neutral heartbeats at the original interval; a newer successful
reply supersedes only older timer heartbeats. Missing all replies still releases input at the original
deadline, without increasing HID timeouts or replaying actions. New rounds, reconnection and close
retire old heartbeats, including delayed replies after high-rate input. Completed-guide state also
has a focused actual-LVGL object-stability check across 20 iterations.

| Check | Result and boundary |
| --- | --- |
| PC checks | typecheck/build PASS; serial/TCP/connection focused regressions 50/50 PASS, with the single-lost-reply scenarios failing before the fix and passing after it |
| EXE checks | self-test PASS; 12 offline scenarios PASS, including official MCP SDK and stdio. These are offline checks, not current real-device input acceptance |
| UI checks | Actual-LVGL completed-guide state/object stability across 20 iterations PASS; this does not establish a complete physical-button flow |
| ESP Build | Firmware gate and independent archive recheck PASS |
| Flash | PASS: COM5 App-only write and hash verification, preserving NVS/PHY |
| Device connectivity before flashing | The running sidecar selects TCP `192.168.100.167:3333`. A raw TCP connection failed within 5s, and UDP/ICMP/ARP were unreachable. USB PING passed 20/20 with a 32ms maximum, but Bluetooth reported disconnected |
| Startup observation after flashing | Eleven `NETSTATUS` replies were normal during 35s, with 21 replies to 23 UDP requests and no observed panic; this only describes that window |
| Continuous Wi-Fi control link | FAIL: the new EXE connected through the official SDK to the actual MCP server, then reproduced a PING acknowledgement timeout at status sample 6 (the seventh request). Evidence: `apps/android-mcp/build/mcp-v21-live-status.json`. A short startup observation does not replace continuous-control acceptance; Wi-Fi is not claimed fixed |
| Subsequent COM5 validation | PASS: the new EXE's actual MCP server handled 15/15 official-SDK `android_hid_status` calls without timeout, maximum 59ms. Evidence: `apps/android-mcp/build/mcp-v21-usb-status.json`. This validates neutral connectivity, not phone input |
| Current PC service | The EXE is running; health reports `status=ok`, buildId `f5636ed8fec2fa799e01`. Local configuration has empty `ESP_HOST` and `ESP_PORT=COM5`. Phone LAN screen-sharing configuration remains intact; no automatic failover or longer timeout was added |
| Device tests | PARTIAL: COM5 neutral connectivity passes while continuous Wi-Fi control remains FAIL. Final Bluetooth `connected/encrypted/ready` are all false; the phone needs to reconnect to its existing paired device. No actual nonzero phone input was sent, so complete real-device remote control is not a PASS |
| Unverified | Actual input after Bluetooth reconnects, complete physical onboarding and longer-term stability remain unverified |

PC EXE buildId: `f5636ed8fec2fa799e01`.
EXE SHA-256: `7c4f40229d7ef8d73a2699b3c842c8188184d4414a1a0c421cd5826999e85b93` (93,345,280 bytes).
ESP merged SHA-256: `cc0e496af53b0c633fcf9c72618b30cda4d80c7ed723003cb4a1a94ce2bb2ea8` (1,721,680 bytes).
App SHA-256: `dc714d2225c93610379a99c590378db432f0bca5d56ded449a256a9c06c97adb` (1,656,144 bytes).
ELF SHA-256: `1ed6fd5185dfcbf5da9f2bd9ba509bf94a635d6d0d8cc89fe86504087d66475a`.
Archive: `apps/esp/build/firmware/cc0e496af53b0c633fcf9c72618b30cda4d80c7ed723003cb4a1a94ce2bb2ea8/manifest.json`.
The previous local Wi-Fi configuration is retained in ignored `qdd-android.v21-wifi.json`; nothing was published.

## v20 Reboot fix and skippable onboarding — built and flashed, 35s observation passed

2026-10-17: The user reports repeated reboots. Serial captured a `Stack protection fault` without
a complete backtrace; evidence: `apps/esp/build/onboarding-v19-reboot-serial.log`. The fixed call
chain in the matching v19 ELF already requires at least 2,976 of 3,072 stack bytes, supporting
insufficient stack space as the cause. A new matching ELF and device stability observation are
still needed to establish the fix. v20 moves the 1,024-byte `poll_udp` response buffer from the
local stack to worker-owned BSS without increasing the task stack or changing downloads.
The new matching ELF confirms a reduction of the static `poll_udp` stack frame from 1,152 to
128 bytes and of the fixed main call-chain lower bound from 2,976 to 1,952 bytes. The task
stack remains 3,072 bytes, leaving a nominal 1,120 bytes, not a measured high-water mark.
BSS increases by 1,032 bytes, including the 1,024-byte response buffer.

QR/App-installation and Bluetooth-pairing instructions add Skip choices valid for the current
boot only. The guide removes Emergency stop and retains Skip/Settings; the normal control page
retains emergency stop. Skipping changes instructions only, never actual download progress,
secure BLE connection, readiness or input capabilities.

| Check | Result and boundary |
| --- | --- |
| Focused host tests | Actual-handler, pure onboarding UI-model and 220-glyph checks PASS; the dedicated actual-LVGL `--guide` run PASS (exit 0). These are focused checks, not a complete host gate |
| Guide previews | Four PNGs covering QR with Skip, Bluetooth, computer and normal unpaired states were visually checked without occlusion or missing glyphs; these are host renders, not physical-LCD acceptance |
| Default full UI run | Did not pass: an older Wi-Fi-name assertion expects complete `1. Updated network`, while the existing 108px name region truncates it. The assertion was not changed in this iteration and is separate from the new guide checks; full Host tests must not be marked PASS |
| Build | PASS: ESP-IDF firmware gate, layout, merged image and matching archive verification; this does not cover the failed default full-UI case above |
| Flash | PASS: COM5 App-only write of 1,656,016 bytes at `0x10000`, `Hash of data verified`, preserving NVS/PHY |
| Device tests | PARTIAL: the 35.1s serial/UDP startup observation PASS. Twelve `WIFI_STATUS` replies were normal, remaining connected at `192.168.100.167`; 26 discovery requests received 23 replies, with empty `faults`/`serialErrors`/`bootMarkers`. No reboot or stack fault was observed within this window. Evidence: `apps/esp/build/onboarding-v20-startup.json` |
| PC service | The device console EXE is running again; `GET /health` returned `status=ok` at `http://192.168.100.160:8790/` |
| Unverified | Physical-button skip actions, complete onboarding and longer-term stability remain unverified. The 35s window does not establish long-term stability; download investigation is not resumed |

Merged SHA-256: `676cff3e8e29dc390893caa77a4e43ff7600047909e134a288f0abc17fec2f93` (1,721,552 bytes).
App SHA-256: `6224adf5eb185e422b77480598bcdd7465c0a39cad27c20352cd62894745c67e` (1,656,016 bytes).
ELF SHA-256: `a1a83ae5ef4fa1243101ec3c577ae4a6f17e113d8e85a90219a1eeffc5b6aa91`.
Archive: `apps/esp/build/firmware/676cff3e8e29dc390893caa77a4e43ff7600047909e134a288f0abc17fec2f93/manifest.json`.

## v19 Radio and memory diagnostics — built and flashed

This version only adds diagnostic fields for RSSI, channel, Wi-Fi power-saving mode, free internal
heap and the largest free block. Actual radio diagnostics were not obtained; neither completed
diagnosis nor a download speedup is claimed. This version includes the v17 scan activity indication
and the fix that retains onboarding progress when moving to Bluetooth pairing instead of returning to the QR step.

| Check | Result and boundary |
| --- | --- |
| Host tests | Focused diagnostic-field checks PASS; this is not a complete host gate |
| Build | PASS: compilation, layout and matching archive verification |
| Flash | PASS: COM5 App-only write of 1,654,416 bytes at `0x10000`, hash verified, preserving NVS |
| PC service | The device operator desktop EXE is running again |
| Device tests | The user reports working downloads on the real device. The maintainer has not personally completed physical-LCD onboarding, scan-animation or pairing-return acceptance; radio diagnostics were not obtained |

Merged SHA-256: `1a61a0193562b1e7eb28e0ecee103115e5115926365e8c2d13cdab45c5fbb5aa` (1,719,952 bytes).
App SHA-256: `82a1282c3df1080f451407c0d40c8f610fd4314f2db4b224353095680e5aa108` (1,654,416 bytes).
ELF SHA-256: `8fdc8efaf26989be076648df96815d3773c7a957e99e9f4e097ae12ba56695bc`.
Archive: `apps/esp/build/firmware/1a61a0193562b1e7eb28e0ecee103115e5115926365e8c2d13cdab45c5fbb5aa/manifest.json`.

## v18 Bounded socket writes and HTTP diagnostics — historical automated probes

2026-10-17: Following the premature close during repeated v17 downloads below, an HTTP
`send_override` now limits each native socket write to 2,048 bytes. Zero-byte returns fail,
and negative returns record errno. Responses still use the SDK fixed-length path with
`send_wait_timeout=2`; the timeout has not been increased. The status endpoint adds non-sensitive
HTTP diagnostics to distinguish native write failures from other transport problems.

| Check | Result and boundary |
| --- | --- |
| Host tests | Focused handler checks PASS for partial writes, zero returns, write errors and bounded JSON output; this is not a complete host gate |
| Build | PASS: compilation, layout and matching archive verification; log `apps/esp/build/onboarding-v18-build.log` |
| Flash | PASS: COM5 App-only write of 1,654,112 bytes at `0x10000`, hash verified, preserving NVS |
| Sequential PC downloads | All three curl runs failed: runs 1/3 received HTTP 200 but zero body bytes and reached the 20s deadline (exit 28); run 2 received HTTP 200 but only 5,513/49,634 bytes before closing early (exit 18). Evidence: `apps/esp/build/onboarding-v18-curl-downloads.json` |
| Phone curl probe | An ADB-launched curl request over the phone's own Wi-Fi with a 20s deadline received HTTP 200 but only 7,079/49,634 bytes before timing out; this probe is not equivalent to the user's browser download |
| Serial observation after failure | Read-only serial status still reported `connected=true`; this does not establish working HTTP delivery or exclude other radio/runtime problems |

Merged SHA-256: `62f68963b8f27f874ab6b5f894dac178112dc95b4293320bbc238a3f803a52c0` (1,719,648 bytes).
App SHA-256: `779b0439a6412f615aac3ada8d59b4de0616cb8cd7e2059209bf2ee2a997ce4f` (1,654,112 bytes).
ELF SHA-256: `c4de01fd3d87074acf93af110dbb3776d9db533a2b68d0cc83945f0cb27d2b4d`.
Archive: `apps/esp/build/firmware/62f68963b8f27f874ab6b5f894dac178112dc95b4293320bbc238a3f803a52c0/manifest.json`.
The automated probes above are FAIL, not a conclusion that the user's download feature fails;
the user subsequently reported working downloads. The difference between these probes and actual
use has not been established, and no speedup or unique cause is claimed.

## v17 Onboarding progress, fixed-length responses and Wi-Fi policy — repeated transfer still closes early

2026-10-17: The landing page is assembled with an explicit length and sent once through
`httpd_resp_send`; the APK uses its embedded pointer and exact length through the same SDK API.
Application chunk/retry loops are removed, and `downloaded=true` is set only after send success.
The SDK `send_wait_timeout=2` remains unchanged. Wi-Fi initialization uses `WIFI_PS_NONE`, and closing
a TCP controller no longer restores modem power saving, including USB and first-download use.

App registration progress now remains separate from the 15-second registration TTL. A phone moving
to Bluetooth settings no longer returns to the QR/download step when its heartbeat expires.
Expiration still removes live endpoints and projection state. Wi-Fi loss invalidates live phone/PC
registrations while retaining download/App-seen milestones for the current boot. After secure BLE
is ready, step 5 asks the user to return to the App; fresh registration, active projection and a live
controller remain required to complete initial onboarding. These milestones are not persisted across restart/reset.

The scan list immediately displays a 40 x 40 LVGL spinner and messages that scanning usually takes
3–5 seconds. The animation continues independently of cached status refreshes. While busy, only
Back is selectable: short OK returns to Settings while scanning continues, and UP/DOWN cannot
select stale SSIDs. Completion, failure and leaving the page destroy the spinner/animations.
The 14/20 px font subsets now contain 217 non-ASCII and all 95 printable ASCII characters.

| Check | Result and boundary |
| --- | --- |
| Host tests | Focused onboarding-response, Wi-Fi, registration-expiry/network-invalidation and onboarding UI-model checks PASS; this is not a complete host gate |
| Scan UI checks | Focused actual-LVGL `--scan` glyph/layout, animation-angle changes with cached status and completion/failure/Back cleanup PASS after relinking; setup-model checks PASS. This is host validation, not physical-panel acceptance |
| Build | PASS: final ESP-IDF compilation, layout and matching archive verification; log `apps/esp/build/onboarding-v17-build-final.log`. The earlier build stopped to include new fixes retains its partial log `apps/esp/build/onboarding-v17-build.log` |
| Flash | PASS: COM5 App-only write of 1,653,520 bytes at `0x10000`, hash verified; erase range `0x10000..0x1a3fff`, preserving NVS. Log: `apps/esp/build/onboarding-v17-flash.log` |
| First actual LAN probe | Node 5s requests all returned 200: page 1,063ms, status 850ms, APK 1,869ms/49,634 bytes with expected SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`. Evidence: `apps/esp/build/onboarding-v17-lan-after.json` |
| Repeated downloads | The first two curl runs with a 20s deadline received complete APKs with correct hashes; run 3 exited 18, received 200 headers but 0/49,634 body bytes, and closed early. Evidence: `apps/esp/build/onboarding-v17-curl-failure.json`. Stable download is not a pass |
| Serial observation after failure | After roughly 0.8s, read-only `NETSTATUS` still replied configured/connected with IP `192.168.100.167`. No panic was observed during this bounded check; this does not exclude every restart or RF issue |

Merged SHA-256: `c406fda1b03bb44c714a7f79901d237a28f11685b73ce9897ac364f5156d5884` (1,719,056 bytes).
App SHA-256: `b48433843b2fef27cdff175019a40d0366eae098ba3da491b25fcad709f580ed` (1,653,520 bytes).
ELF SHA-256: `31d015819ac3160bc1d67f9fd73969bf46214b182889c838e388961136ab0e67`.
Archive: `apps/esp/build/firmware/c406fda1b03bb44c714a7f79901d237a28f11685b73ce9897ac364f5156d5884/manifest.json`.
The initial complete transfer and later failure are both retained; neither stable delivery nor a unique cause is established.
New onboarding progress, scan waiting animation, timing text and Back behavior are flashed but still require physical-interaction acceptance.

## v16 Private HTTP socket latency — mixed device results

2026-10-17: The only subsequent transport change sets `TCP_NODELAY` on accepted private-LAN HTTP
sockets. Focused HTTP/socket host checks pass. This targets the v15 delayed/header-splitting symptoms;
Actual runs below had mixed outcomes; stable delivery and a unique underlying cause are not established.

| Check | Result and boundary |
| --- | --- |
| Host tests | PASS for focused HTTP/socket checks only; no complete host gate result is claimed |
| Build | PASS: compile, layout and matching archive verification; log `apps/esp/build/onboarding-v16-build.log` |
| Initial flash attempt | Failed before any write: opening COM5 raised `FileNotFoundError(2)`; enumeration found no serial ports and UDP found no board. Original log retained: `apps/esp/build/onboarding-v16-flash.log` |
| Flash after reconnection | PASS: the same verified efbb bundle wrote 1,653,008 App bytes at `0x10000`, hash verified; erase range `0x10000..0x1a3fff`, NVS preserved. Log: `apps/esp/build/onboarding-v16-flash-reconnected.log` |
| Serial startup response | PARTIAL: read-only `WIFI_STATUS` replied `configured=false`, `connected=false`, empty IP, confirming running firmware but no configured Wi-Fi. Evidence: `apps/esp/build/onboarding-v16-serial-status.json` |
| First LAN probe after manual connection | Node 5s requests all returned 200: page 679ms, status 656ms, APK 4,969ms/49,634 bytes with expected SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`. Evidence: `apps/esp/build/onboarding-v16-lan-after.json` |
| Independent repeat | A following curl request with a 20s deadline returned code 200 but only 27,648/49,634 bytes; TTFB 0.858120s, total 20.015450s. Retained evidence: `apps/esp/build/onboarding-v16-apk-curl-failure.json`, `apps/esp/build/onboarding-v16-apk-headers.txt`, partial `apps/esp/build/onboarding-v16-real.apk`. Stable download is not a pass |

Merged SHA-256: `efbb291922f47e9dae6e942ba755b07a92110a5f1895b5c308e2037fcf6299fa` (1,718,544 bytes).
App SHA-256: `4ebe846851bec4a5390414ebb9473c5453fb58aa0aa245d260dc9225be53c4bd` (1,653,008 bytes).
ELF SHA-256: `c815854717cde475b2da6d8be6abe2000fb75683c6f0a780741d709ad79f7956`.
Archive: `apps/esp/build/firmware/efbb291922f47e9dae6e942ba755b07a92110a5f1895b5c308e2037fcf6299fa/manifest.json`.
The initial missing-port failure remains part of the record; the same verified bundle was subsequently installed.
Summary evidence: `apps/android-mcp/build/device-tests/firmware-final-v16.json`.
Physical menus/password clearing remain unverified. Both the complete first transfer and truncated repeat are retained; no stable-download or unique-root-cause conclusion is claimed.

## v15 Password clearing, Wi-Fi retries and dual-stack LAN onboarding

2026-10-17: The password completion menu adds **Clear password**, retaining Delete one.
Clearing wipes the complete password buffer, including bytes beyond the current string, and returns
to row selection while retaining the SSID and keyboard position. The vertical menu now has five items.
An unconfigured board now remains on onboarding step 1 at startup instead of automatically entering Wi-Fi setup. The user selects Settings and then Wi-Fi to start scanning; this adds no control state.

The ESP-IDF HTTP listener was confirmed to use `PF_INET6` dual-stack sockets. Private IPv4 peers
can therefore arrive as IPv4-mapped IPv6 addresses. Onboarding now normalizes those peers before
applying the existing private-LAN rule, while retaining ordinary IPv4 support.
Before the fix, actual LAN requests to the installed firmware at `http://192.168.100.167:3334/`
returned HTTP 403 for both `/` and `/api/status`; evidence: `apps/esp/build/onboarding-v15-lan-before.json`.

Initial Wi-Fi association now permits four attempts with 500/1000/2000 ms backoff, keeping
`connecting=true` and `failed=false` during retries and reporting failure only after exhaustion.
Immediate connection-API errors are retried; transient `WIFI_STATE` configuration errors retry after
250 ms. Stale, wrong-interface and wrong-SSID GOT_IP events are rejected. Reconnection for previously
connected networks retains bounded backoff; `ALL_CHANNEL_SCAN` selects by RSSI without pinning a BSSID.

| Check | Result and boundary |
| --- | --- |
| Onboarding handlers | PASS for focused landing/scan page, APK download, status and registration regressions, including IPv4-mapped peers; this is host validation, not a phone-browser acceptance |
| Wi-Fi backend | PASS for focused retry/configuration-state/stale-IP regressions; the complete host gate was not run |
| Password/setup model | PASS for the focused pure-model program, including complete-buffer clearing, retained SSID/position, empty-password clearing and existing single-character deletion |
| UI compilation | PASS: UI/model/fonts and mock getter compiled and linked; UI test cases were not executed |
| Build | PASS: final ESP-IDF compilation, layout and matching archive verification; log `apps/esp/build/onboarding-v15-build-final.log` |
| Flash | PASS: COM5 App-only write of 1,652,976 bytes at `0x10000`, hash verified; erase range `0x10000..0x1a3fff`, preserving NVS; log `apps/esp/build/onboarding-v15-flash.log` |
| Actual LAN responses | The board automatically rejoined `192.168.100.167`; `/api/status` returned 200/512 bytes. Node 5s requests for the page/APK timed out; a 12s curl page attempt produced no complete response, and one status sample took 3.19s with separately arriving headers. Evidence: `apps/esp/build/onboarding-v15-lan-after.json` |
| APK integrity under a longer deadline | A separate 20s curl request completed: HTTP 200, 49,634 bytes, TTFB 4.342146s, total 10.688854s; SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812` matched the expected APK. Evidence: `apps/esp/build/onboarding-v15-apk-curl.json`. Earlier short-deadline failures remain valid; responsiveness is still poor |
| Device tests | Actual LAN status/APK transfer was observed as above; physical password-menu, retry/radio behavior and phone-browser flow remain UNVERIFIED |

Merged SHA-256: `1dfb61496156a047546609cd8737fcc8178f10012a1732ba2ee4ae022fa6f579` (1,718,512 bytes).
App SHA-256: `93fbed860a0edd14926f497ecf0e64adf2e11b4b7fc3f48992363f69f6da1090` (1,652,976 bytes).
ELF SHA-256: `437cbf4de1dd7eddf7f98563d4a1272023e5620320e140d343902be59148e6fa`.
Archive: `apps/esp/build/firmware/1dfb61496156a047546609cd8737fcc8178f10012a1732ba2ee4ae022fa6f579/manifest.json`.
The successful long-deadline APK transfer does not establish acceptable page/download latency or a unique cause.

## v14 ESP Wi-Fi scan completeness and pagination

2026-10-17: The scan limit increased from 8 raw records to the strongest **64 distinct SSIDs**.
The complete SDK AP list is traversed before selection; duplicate SSIDs retain their strongest AP,
and results are sorted by RSSI. The board uses the China 2.4 GHz channel range **1–13** and
**100–300 ms** active dwell. Published/staging AP lists use static storage; the compact status
snapshot carries a scan revision, and a revision-checked getter copies only one AP at a time.
The four-row UI can reach every result, Rescan and Back; Back retains the final page, and a new
scan revision refreshes names even when the count is unchanged.

| Check | Result and boundary |
| --- | --- |
| Build | PASS: ESP-IDF 5.5.3 compile, layout and matching archive verification |
| Host tests | PASS for focused Wi-Fi backend regressions only; the complete host gate was not run |
| UI compilation | PASS: native UI/model/font compilation and mock-getter linking only; UI test cases were not executed |
| Flash | PASS: COM5 App-only write of 1,651,520 bytes at `0x10000`, written-data hash verified and RTS reset; log `apps/esp/build/wifi-v14-flash.log` |
| PC service | Restarted; `GET /health` returned `status=ok`, buildId `ee8995646ca7089ab7ec`, runtimeVersion 9, operator URL `http://192.168.100.160:8790/`; evidence `apps/android-mcp/build/device-tests/firmware-final-v14.json` |
| Device tests | NOT RUN: physical scan completeness, actual RF/channel behavior, and menu/pagination on the board remain UNVERIFIED |

The erase range was `0x10000..0x1a3fff`; NVS/PHY and existing saved settings/bonds were preserved.
This flash did not invoke factory reset (`resetTriggered=false`). It does not establish that every
nearby network is visible, and the ESP32-C3 still scans 2.4 GHz only.

Merged SHA-256: `bede789711c50b673df0b525665a92cd265478eff11fcd99e3dda203f9520ab0` (1,717,056 bytes).
App SHA-256: `c45b3eabcb146a081585385a9e522e9c2b5cd9af7c631fadf9cf5adc66e0c6eb` (1,651,520 bytes).
ELF SHA-256: `72aa50d2e69494dbdb6ca4c2a499c869b181bb440725490f7f4284525072fa08`.
Archive: `apps/esp/build/firmware/bede789711c50b673df0b525665a92cd265478eff11fcd99e3dda203f9520ab0/manifest.json`.
Successful build log: `apps/esp/build/wifi-v14-build-fixed.log`. Earlier version evidence below is historical.

## v13 ESP settings factory reset

2026-10-17: Settings now includes Reset device, defaulting to Back on its confirmation page.
Physical confirmation of Clear and start again releases input and reboots; default NVS is erased
before BLE/Wi-Fi start and initial onboarding resumes. Forget the old phone Bluetooth bond and pair again.
Only the App range `0x10000..0x1a2fff` was updated; existing NVS was retained and reset was not invoked.
Build: PASS (compile/layout/archive verification). Host tests: NOT RUN. Device tests: NOT RUN
(skipped as requested; COM5 flash and written-data hash verification succeeded).
Unverified: physical menu and actual reset workflow.
Merged SHA-256 `4f65a1e31e90afb7068c736fa5d41b2dbd6a485c60f765827af737a5228c2699`;
ELF `6460009723503134474b489277044bebc9eeef7e3f8d2af705c113355484c879`.
Logs: `apps/esp/build/reset-v13-{build,flash}.log`. The v12 device results below belong to earlier firmware.

## v12 Device Console, preview profiles and controller cards

Checkpoint: **2026-10-17. Packages, four profiles and one-minute physical60Hz input pass;
sustained visual smoothness and idle MCP connection stability do not yet pass.** This section identifies the current version;
v11 and earlier evidence remains below as history.

| Check | Result and evidence |
| --- | --- |
| LAN console | Defaults to `0.0.0.0:8790`, advertises actual private addresses, and accepts loopback/private peer, Host and Origin for HTTP/MCP/WebSocket. Public/invalid sources are rejected. The actual OnePlus reached PC `/health` through Wi-Fi: `phone-to-console-lan-v12.json` |
| Product and design | Device Console on PC, Device Controller on ESP and Device Screen on phone. All use dark cards and `#d4380d`; existing BLE identifiers and MCP wire names stay compatible |
| ESP navigation/manual | 14px body/20px headings; three unlabeled accent segments follow the visible right edge, with 4px end gaps. UP/DOWN select; emergency stop is selected by default, confirmation changes it to cancel stop. Only local confirmation unlocks. Settings/back are vertical, existing password row/character input remains. Manual matches photographed housing, strap opening, upper screen, speaker and side keys; no power-key hint |
| ESP host checks | Real LVGL glyph/bounds/edge/manual pixels, incremental/full-frame equality, 100 static updates with zero flushes, 120 stable page switches, rapid navigation and stop precedence pass. 201 non-ASCII +95 ASCII glyphs at14/20px; 24KiB pool peak17,080 bytes. Two real QR decodes pass; these do not replace physical camera/button acceptance |
| Physical profiles | Same phone/owner,20s each:360 grayscale **14.60fps**,540 color **16.35fps**,720 color **10.95fps**,1080 original **7.30fps**.2401/2401 small30Hz MOVE acknowledgments, no additional video disconnect/error. This run used ESPv11, not the new UI firmware: `profiles-v12.json` |
| Original images/coordinates | Pillow checked8 JPEGs: turbo is genuinely grayscale and every MCP profile returns fresh1080×2400 color originals. Preview changes retain physical coordinates and control round. Original requests391–823ms; cleanup restored standard and released input |
| Latency limits | Source-age median/P95:51/113,44/113,105/298,165/499ms. Protocol ACK median about2ms/P95 about7ms is not visible phone response latency. Maximum frame gaps remain around1s; delayed frames arrive with older source ages in bursts. This does not establish pending1000ms as the cause;7cff APK stays frozen rather than loosening freshness or inventing frames |
| MCP cancellation | Cancellation reaches original HTTP/FIFO, queued jobs reject promptly and skip their send, active bodies cancel and late responses are not published. Other observers/preview streams are unaffected. Six focused regressions were red before and green after; actions are never replayed after image timeout |
| Windows port collision | Windows can overlap wildcard and specific-address listeners. TCP preflight detects occupied fixed ports and enters existing alternate-port settings. Original loopback/non-HTTP fixtures stayed intact and running; regression passes |
| PC gates/EXE | Final typecheck/build,Node383/383,root CLI35/35 pass; EXE12/12 plus120s loopback stress pass:150KiB fixtures at30.05fps,max gap48ms, no replay after lost ACK,reconnect/cleanup pass. Fixture FPS is not physical phone FPS. Logs:`delivery-v12-*.log` |
| Observer/profile fixes | A read-only original failure no longer stops another input owner; the owner's own failure still releases safely and old failures cannot stop a new owner. Four regressions pass. Displayed stream profiles synchronize the selector/text, while pending local choices and late old frames are protected; full VM62/62 pass |
| Binary write fix | Original large-frame test failed in the full run but passed twice alone. Deterministic bursts then proved final-frame/loss-event drops. One active write plus one latest pending record now flushes by callback, counts queue age,drops frames over3s and preserves loss priority. Three red-to-green regressions and15/15 stream tests pass; original1s deadline/fixtures unchanged |
| Final ESP firmware/MCP | Photo-manual firmware passed the complete gate and three segmented COM5 flash hashes,retaining NVS/PHY/bonding. Earlier9aed EXE's13 MCP calls/42 reports remain in `exe-real-v12.json`. Final ee899 EXE initialized/listed20 tools,completed10 calls and42/42 reports,but its socket was closed at the following16s idle check. Cause remains unknown:`exe-real-v12-owner-fix.json`; overall MCP stability is not a pass |
| Final60Hz physical stress | First9aed run ended around49s after2950 sent/2948 ACKs; original FAIL remains:`exe-real-soak-v12-final.json`. Final ee899 EXE/photo-manual firmware passed60s,3600/3600 maximum alternating±127 MOVE reports at60Hz. ACK median2.14ms/P95 7.01ms;694 frames/11.57fps,source-age median101ms/P95 301ms,max gap1331ms,so visible stalls remain. Cleanup restored standard/armed=false with connected/encrypted/bonded/ready BLE:`exe-real-soak-v12-owner-fix.json`. This later pass neither erases prior failures nor proves their cause fixed |
| Final browser | Reloaded the final EXE page; actual LAN video,three ready indicators and standard-profile text are visible. Remote input was not entered and remains released:`operator-v12-final.png`. Picture-entry/Esc device acceptance was not repeated in this run |

EXE:`build/windows/设备操作台.exe`,buildId`ee8995646ca7089ab7ec`,runtimeVersion9,
SHA-256`27771d8856f567299f91660c404f3f8358b03f51cb36726bc48e0687539d6357`,93,252,608bytes.
Installed APK SHA-256:`7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`;
the actual system base.apk on OnePlus serial`dcf4e720`was pulled and matched.
Console:`http://192.168.100.160:8790/`;MCP:`http://192.168.100.160:8790/mcp`.

Final ESP merged SHA-256:`d5f3e4c493506804cd0c2ae0a1dd56a8e3f4eb1de1d0c9fa1efdd8898eb83d2b`;
ELF:`78cc0a475ec56c9f4eb4622821fc2f3e0d6aadc78f150951cb25c1517592191f`.
App1,645,552 bytes,merged1,711,088 bytes. The embedded APK matches the installed package above byte for byte.
Only bootloader,partition table and App segments were written; NVS/PHY at`0x9000..0xffff`was untouched.
Complete gate/flash logs:`apps/esp/build/device-ui-v12-photo-final-{gate,flash}.log`.

Runtime images use LAN MediaProjection and all input uses ESP BLE. ADB is limited to installation,
consent preparation and diagnostics. New physical menu/display, complete real camera onboarding,
other vendors and sustained30fps remain unverified. No commit/push; automation stays PAUSED.

## v11 Historical: fixed capture, fast swipes and connection guide

Checkpoint: **2026-10-17. Static capture downgrading is removed and fast-motion regression
passes; sustained 30fps delivery and the actual ESP LAN first-connection flow remain unverified.**
v10 below is historical; this section identifies the artifacts used at that time. See v12 above for the current version.

| Check | Result and evidence |
| --- | --- |
| Capture cadence | Connected streams target fixed 33ms, including static screens. Two alternating ImageReaders allow one pending composition; independent JPEG worker/two bitmaps/one latest pending image. Original 1080×2400, JPEG75 and genuine capture timestamps remain |
| Physical static comparison | Old 60s: PC 1.78fps/direct phone 1.80fps. Fixed capture produced about 25–27fps on the phone. First single PC run delivered 6.05fps; another 60s with session Wi-Fi performance lock delivered **8.2fps**, source-age median 157ms/p95 348ms, no stream loss/timeouts. This run does not guarantee a throughput increase on every network. See `preview-{baseline,single,wifi-lock}-v11.json` |
| Fast motion | Browser overflow now coalesces/clamps pure motion rather than incorrectly stopping. Button/key edges remain ordered. Physical COM5→BLE passed **3601/3601** maximum ±127 MOVE reports in one minute, ACK median 2.00ms/p95 6.87ms, no errors: `exe-real-soak-v11-fast.json`. This used v10 ESP firmware, new PC and the first fixed-capture APK |
| ESP six-step guide | Wi-Fi→QR/IP→App download/install→phone Bluetooth→PC EXE→operate. Board serves its embedded APK over HTTP3334 with UDP3335 discovery. Tips explain scanning or browser address download and require phone/PC/ESP on the same LAN. Registration grants no input rights; physical DOWN has priority |
| Discovery ownership | Phone collects/deduplicates replies, selecting automatically only a unique board; multiple boards require the intended QR. Changed IP recovery matches the selected device name. Old requests cannot overwrite new selections. PC discovery fills phone URL/UUID without controlling before Save; USB selection is retained |
| Regression | Repository typecheck/build PASS; Node **338/338**, operator **47/47**; EXE **11/11** packaging/HTTP/stdio/lifecycle PASS; native socket/pixel/cadence/setup/Wi-Fi-lock regressions PASS; ESP Chinese layout/203 non-ASCII glyph coverage/actual rendered QR decoding PASS |
| Same-version physical MCP | Final EXE/APK/ESP: official SDK initialize/listTools 20 entries, 13 tool calls, 42 WS reports and 63 heartbeats PASS. Home/move/back/wait returned actual new post-action images. Final release retained encrypted bonding: `exe-real-v11.json` |
| Final firmware continuous input | Final matching artifacts passed **3600/3600** maximum alternating MOVE reports at 60Hz for one minute. ACK median1.99ms/p95 6.83ms; source-age median128ms/p95 273ms; 697 frames/**11.62fps**, no errors. This used the desktop wallpaper and does not replace the App static-content 8.2fps comparison: `exe-real-soak-v11-final.json` |
| Final browser | Actual IAB picture entry/Esc exit PASS. Final display showed about11–13fps and all three connection indicators ready. Left outside remote input with projection continuing: `operator-v11-final.png` |

Current EXE buildId `4738559a1d6f4e80029a`, runtimeVersion=7, SHA-256
`eec2f0923406af9bd8ed973f140e7d8ebede3776f47fce4f5c5712967e0c3ec7` (93,224,448 bytes).
Final APK SHA-256 `e3ada15f097807ff5ee1750ff8dc498ce04b93a8bd88f88bc4c3b107f1bda234`
(45,538 bytes) was installed and verified against the actual system base.apk.
The OnePlus reports its high_performance lock held.
Final ESP merged SHA-256: `b2d3ca6c37d5d0a06315abba868bdef03bbe602cc1c71e46c1302baf761a2a70`;
ELF: `b4f2b7f4dacc9a4ea217512177cf1c709509dc09169481e223d7eccad0ad6e06`.
App 1,652,576 bytes, merged 1,718,112 bytes. Full C/LVGL and 124 Python checks passed
(21 existing platform skips). An exact byte search verified that the embedded 45,538-byte APK
matches the final installed package. The partition table matches v10. Segmented writes to the
same COM5 C3 used 0x0/0x8000/0x10000, leaving NVS/PHY at 0x9000..0xffff untouched;
the existing encrypted BLE bond recovered automatically.
Gate/flash logs: `apps/esp/build/onboarding-v11-{final-gate,flash}.log`.

Automatic approval rejected USB configuration of the ESP's current Wi-Fi (`blocked by policy` only).
No alternate interface was used. COM5 remains available for integration; the board must join the LAN
through its existing screen keyboard before actual download/phone registration/PC discovery can be tested.
Host simulation, rendered QR decoding and API compilation are not physical camera-scan acceptance.
Runtime pictures use LAN MediaProjection and input uses ESP BLE; ADB is installation/consent/read-only
diagnostics only. Physical camera scanning, active AP/IP changes, actual multiple boards, other Android
vendors and sustained 30fps delivery remain unverified. No commit/push; automation remains **PAUSED**.

## v10 Historical: Windows EXE and connection stability acceptance

Checkpoint: **2026-10-17. Windows EXE, official MCP, the OnePlus/COM5 core path and
two-minute continuous physical control PASS.** The phone supplies real MediaProjection
video over Wi-Fi at `192.168.101.46:8791`; the PC connects to ESP over USB COM5, retaining
the encrypted BLE bond. No runtime ADB screen/input fallback was used. Click the picture
to enter, Esc to exit, continued control outside the picture; no start/capture/pause buttons.

| Current check | Result and evidence |
| --- | --- |
| Single Windows EXE | `build/windows/QDD-Android.exe` embeds Node 24.15.0, five web assets and native serial module; empty PATH and Chinese/space/# paths passed, without separate Node/npm |
| EXE settings/lifecycle | **11/11 PASS**: first setup including concurrent-submit no-overwrite, duplicate reuse, owned older EXE replacement, five same-process configuration/port reloads, native/TCP release, foreign occupied-port recovery and old setup-listener cleanup |
| Input channel | Browser WebSocket is independent of video/MCP HTTP connection pooling; four ordered pending ACKs, 250 ms renewals independent of ACKs; connection loss releases without replay |
| Recovery | Viewing reconnects with 0.5/1/2/4/5 second backoff; explicit picture click starts fresh input. Old reports, neutral heartbeats and tool timeout/cancellation cannot stop newer control rounds |
| Host gates | Root typecheck/build PASS; `test:android` **319/319 PASS**, including 46 MCP, 46 serial/TCP and 44 operator checks. Log `build/device-tests/host-v11-observer-tests.log` |
| Native app | Socket 12, pixels 3 and capture cadence 2 checks PASS; final APK manifest/hash verified, installed over the phone app, system projection consent granted |
| Real COM5 neutral soak | 181 seconds, 90/90 STATUS and three close/reopen cycles passed; BLE connected/encrypted/bonded/ready=true and armed/locked=false. Zero non-neutral input; `usb-neutral-soak-v10.json` |
| Real static OnePlus LAN | 30 seconds, 55 unique source frames, 1.83 fps; median age 123 ms/p95 267 ms, original 1080×2400, no disconnection/write failure. `native-v10-static.json` |
| EXE official HTTP MCP / real ESP | 20 tools; screenshot and home, two relative moves, escape, back and wait returned JPEGs. Each high-level action returned a different source frame acquired after completion. `exe-real-v10.json` |
| EXE WebSocket / real ESP | 42/42 mouse/key ACKs; median 8.07 ms/p95 14.28 ms; 16 seconds idle and 63 lease replies without disconnect; STOP left armed=false and BLE ready/encrypted/bonded. ACK is not visual latency |
| Final EXE two-minute physical control | **PASS**: 120.008 seconds, 3600/3600 MOVE at 30 reports/s, 465 lease replies and 1819 complete real JPEGs (15.16 fps), no video/input error. ACK median 2.02 ms/p95 6.87 ms; source age median 79 ms/p95 199 ms; finally released/unlocked. `exe-real-soak-v10.json` |
| Read-only observer | A second official SDK client read and closed without stopping the original armed input owner |
| Observer-page pause fix | Read-only hide/offline/close/video-error no longer sends global PAUSE; a page that initiated input still releases on exit. VM red/green regression; runtimeVersion=6 rejects old-page reconnection |
| ESP full gate/update | New 50 ms USB SOF loss confirmation passed the complete gate, 124 Python checks (including existing platform skips) and C/LVGL checks; verified segmented flash at 0x0/0x8000/0x10000 preserved NVS/PHY and bonds |
| Post-fix real direct USB | While receiving actual phone LAN video, 60 seconds and 1800/1800 MOVE at 30 reports/s without heartbeat expiry; before cleanup BLE ready/encrypted/bonded and armed=true. `usb-realtime-trace-v10.json` |
| Real IAB operator | Final EXE/firmware PASS: click-to-enter, whole-page hidden cursor, outside-picture control and Esc restoring cursor without error. Navigating the read-only page to settings and back during sustained MCP input did not interrupt it. `operator-v10-final.png` / `operator-v10-final.json` |
| Duplicate normal EXE launch | PASS; normal entry opened the operator and reused PID 54280 without another service/serial instance |
| Previous package with same transport kernel, loopback soak | Package `4ad1c514…`: 120 seconds, 3602 ×150 KiB JPEGs, 30.009 fps and 4508 WS ACKs; idle, WS reconnect and TCP lost-ACK no-replay passed. **Fixture metrics only; zero real-device input.** `build/windows/exe-soak.json`; final package passed the separate physical checks above |

`android_control` prepares one action and returns a fresh picture; tap/swipe still need
measured calibration. AI input takeover closes the old browser input session so its late
stop/cancel cannot stop the new owner. Current-round failures release held input; physical
DOWN emergency stop remains authoritative.

The previous phone hotspot vanished during this run. After the user supplied the current
network credentials, ordinary system settings joined the phone to the PC's `/23` LAN and
real HTTP identity was verified. A proxy TCP connection was not treated as device proof.
The Wi-Fi password is absent from project/build configuration and test logs. ADB was used
only for installation, network setup, system projection consent and read-only diagnostics.

Original-resolution static capture measured median 81 ms, including 56 ms JPEG encoding.
The 33 ms acquisition interval is a cap: **sustained phone 30 fps and fully smooth remote
control are not established**. The two-minute mouse-motion run measured about 15.16 fps.
Automatic approval rejected opening the animated diagnostic
page through ADB (`blocked by policy`); the operation stopped without an alternate-interface
retry. Complex moving content/sustained 30 fps, deliberate AP/IP recovery, rotation/re-consent, a fresh
physical DOWN/OK check and other Android vendors are not claimed as accepted.

Final EXE SHA-256: `549e491565cf7068e10632c458e8f8bf2cf6684b96b84ec284424e2beb7f62a4`;
buildId `972b70a19caa74ca1b38`, 93,210,624 bytes, runtimeVersion=6.
Installed APK SHA-256: `d2343a4c42539df17524fe651efc981f5d1570384de299707c3bb7ad01117c59`;
the actual installed OnePlus base.apk was read and matched again.
Current ESP merged SHA-256: `24c50368241392d8446af94f08e4fc2585c4d4cd597b387c0994aa108e4e284d`;
ELF: `f104f221c6ecc8add6c53544e2923509a926948e9cdaa14cdb50e04383028814`.
App 1,534,688 bytes, merged 1,600,224 bytes; partition table unchanged from v8, NVS/bonds
not erased. Gate/flash logs: `apps/esp/build/usb-stability-v10-{gate,flash}.log`.

The initial continuous-input attempt failed after 364 reports and remains in
`exe-real-soak-v10-before-usb-fix.json`. Independent USB trace then showed a confirmed
PING at 8453 ms and healthy MOVE at 8640 ms, but `HEARTBEAT_EXPIRED` at 8660 ms.
Transient SDK SOF presence loss immediately cleared controller ownership. The initial
probe incorrectly swallowed async rejections and marked PASS; its raw trace and correction
remain in `usb-realtime-trace-v10-original.json` and `usb-realtime-trace-v10-audit.json`,
and are not passing evidence. Only raw USB loss now requires 50 ms confirmation;
1500 ms PING expiry and physical DOWN remain independent.
Code is uncommitted/unpushed; automation remains **PAUSED**.

## Historical v9 streaming and MCP integration

The following is a v9 phase snapshot. Current progress, process and artifacts are described above.

Checkpoint: **2026-10-17. Binary video and a four-report realtime input window are
implemented; first device measurements show higher throughput. Overall continuous
smoothness is NOT YET ACCEPTED.** Click-to-enter, Esc-to-exit, continued control
outside the picture and whole-page cursor hiding remain unchanged.

| v9 change/check | Evidence and boundary |
| --- | --- |
| Phone capture | At most one frame every 33 ms (about 30 fps), JPEG quality 75; original 1080×2400 geometry retained, packed RGBA and duplicate buffer copies reduced. This is a cap, not measured sustained FPS |
| Updated phone app | APK SHA-256 `d55e935bb6a36b108fe8e67a768c00c723f1073d394f9ab1135984ceb9e540d5` checked against the manifest and installed over the OnePlus 8 app; the user granted projection again and the signing certificate remains the same |
| PC to browser | `/screen/stream` binary JPEG avoids per-frame operator Base64 conversion; only the latest pending decode is kept, and transfer/decode still count toward three-second freshness. SSE remains for compatibility |
| Human input | Up to four pending ACKs, with later submissions no longer waiting for every Wi-Fi reply; per-round sequence numbers retain button/key edges. Missing sequence, cancellation or ACK failure releases input without replay |
| Ordinary AI input | Waits for preceding realtime reports, then runs exclusively; coordinate calibration, screenshot guards and existing positioning cadence remain |
| MCP | 20 tools; new `android_control` uses this session's frameId, prepares one action internally and returns a genuinely new image captured after completion. An image timeout states whether the action completed; never repeat it blindly |
| Session ownership | Closing a read-only observer or video viewer no longer stops another operator; owner disconnect or actual source loss still releases input |
| Targeted host regression | Input/serial/TCP 92/92; screen TS 33/33; native socket 10/10 and pixels 3/3. The final full gate and current-process evidence are pending this round's final integration |
| ESP | v8 merged SHA-256 `8e4045a5bbf943793ef9f10934bb2ac0108e8969ebdc7f9248562d0728cd2462` retained; no flash, descriptor, NVS or Bluetooth bond changes this round |

The first same-backend comparison used real ESP Wi-Fi → BLE → OnePlus, with 48
alternating ±2 MOVE reports and HTTP 200 for every report:

| Input mode | Total for 48 reports | Throughput | HTTP completion median / p95 |
| --- | --- | --- | --- |
| Serial compatibility path | 6.689 s | 7.18 reports/s | 105 / 377 ms |
| Four-report window | 4.190 s | 11.46 reports/s | 305 / 920 ms |

Throughput improved in this run; **lower individual latency was not established**.
The `medianAckMs` / `p95AckMs` fields actually time HTTP submission through complete
result reading, including host queues, ESP confirmation and HTTP round-trip; they
are not isolated BLE ACK, end-to-end visual latency or sustained video FPS. Initial
successful records are retained as `remote-performance-v9-before-initial-success.json`
and `remote-performance-v9-after-initial-success.json`. The earlier old-process
attempt encountered lease-renewal HTTP 409 after 25 reports; it remains in
`remote-performance-v9-before-initial-failed.json` and is not a successful baseline.

Twenty read-only ICMP samples per peer: ESP minimum/mean/maximum 41/268/732 ms;
phone 12/73/208 ms, with no packet loss. See `lan-latency-v9.json`. This measures the
hotspot's round-trip jitter at that time without independently verifying TCP control
state for every sample; it is not BLE or end-to-end control latency. LAN bandwidth
does not guarantee prompt individual messages, and the old 12.5 fps capture cap,
sequential ACK waits and conversions added separate overhead.

Current video, real MCP actions and the new browser workflow are still in this round's
integration; old v8 interaction results do not accept v9 smoothness. Current physical
DOWN/OK/display, other-browser PointerLock, long-running resources, AP/IP recovery,
rotation/STOP re-authorization and other phones remain unverified. Code is uncommitted
and unpushed; automation remains **PAUSED**.

<details>
<summary>Historical v8 — simplified interaction and default input passed, smoothness unaccepted</summary>

The following v8 hashes, process, APK and gates are historical snapshots. The v9
section above describes the current iteration.

## Click-to-enter remote-control checkpoint

Checkpoint: **2026-10-17, v8 interaction/default-input functionality PASS on this OnePlus/IAB;
high-FPS continuous smoothness NOT YET ACCEPTED**. The current UX is
**click the picture to enter, Esc to exit**. Crossing the picture edge must never
exit control: relative input spans the document and the computer cursor is hidden
across the page. The first picture click establishes control only; later clicks
operate the phone's existing real cursor, not the webpage position.

Final host gate: **235/235 Android tests PASS**, including **31/31 actual operator
VM cases**; root build/typecheck/diff checks passed. Log:
`apps/android-mcp/build/host-simple-v8-tests.log`.

| v8 change/check | Current evidence |
| --- | --- |
| Simplified UI | Start/capture/pause buttons and state pills removed; only the fixed click-to-enter/Esc-to-exit instruction remains |
| Entry and full-page input | Implemented: first click establishes control, later document clicks send phone input; captured page clicks cannot also activate toolbar actions |
| Leaving the picture | Real IAB PASS on the new firmware/UI: picture click then another click 15 px beyond its right edge kept remoteActive=true/cursor=none/error=false |
| Cursor and removed buttons | Real IAB PASS: picture entry hides the whole-page cursor; the three old control DOM elements count=0 |
| Idle toolbar | Internally prepares control without a manual ARM step; no manual enable/disable UI |
| Clean Esc exit | Real IAB PASS twice: remoteActive=false/cursor=auto/error=false, activity reported remote control exited. The old timeout path first reproduced two failing VM cases, then passed after fixing polling during exit; real same-round failures remain visible until explicit Esc |
| ESP default activation | Actual PASS: PING → MOVE without ARM; PAUSE → MOVE without ARM or OK; TCP disconnect and 1850 ms lease expiry each yielded fresh STATUS armed=false |
| ESP physical keys | Host policy: DOWN emergency lock, OK clears only that lock, short UP does nothing, long UP retains Wi-Fi settings. Physical DOWN/OK and the board display were not retested this round |
| Complete ESP gate/flash | PASS; verified component flash at 0x0/0x8000/0x10000 on COM5, selected board MAC 4c11ae2fa1b8 checked again; NVS 0x9000–0xefff preserved |

Connection, source ownership, fresh heartbeat, BLE authentication/encryption,
bonding, report readiness and physical stop remain internal gates. Browser entry
and idle toolbar actions handle their setup internally; the UI exposes no manual
enable/disable or pause/resume flow. The MCP compatibility ARM/PAUSE calls remain,
and the current host controller's API/AI call flow is not silently redefined by
the firmware's automatic activation.

Complete firmware gate: PASS, `apps/esp/build/default-control-v8-gate.log`.
Python: 123 total, 21 platform/symlink skips (repository 4/archive 5/install 12).
C/LVGL checks passed; host evidence includes lock priority, 162 glyphs, 17 LVGL
frames and 120 screen changes. No physical display claim replaces the untested row.
App image: 1534528 bytes; merged image: 1600064 bytes; archive verification passed.
Merged SHA-256: `8e4045a5bbf943793ef9f10934bb2ac0108e8969ebdc7f9248562d0728cd2462`.
ELF SHA-256: `cf2e8836ac1055ba8483460bd136cd24a8fcb2793f8801f55a6e84737d597dfe`.
APK remains `0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`.

Evidence: `esp-default-v8-status.json` (Wi-Fi 10.65.201.147, BLE ready/encrypted/bonded,
no crash markers), `esp-default-control-v8.json` (default input/lease checks),
`operator-simple-runtime-v8.json` (bound source hashes/runtime) and
`operator-simple-v8-final.png`. Operator JS SHA-256:
`d1959c048eba49f2ac672d853adbb18c56d10988439ce8efa4c78d63574abb78`.
The runtime status at 05:23:37Z is a valid active snapshot with armed=true, not an
idle/final-state assertion. A copied v7 helper's idle assertion failed on this
active snapshot; it is retained separately and is not a firmware bug.

Service PID **40392**, runtimeVersion=3, runs in tool-managed foreground session
**92816**; health=200 and unknown route=404 passed. Two background Start-Process
attempts were rejected by automatic review; the controlled foreground run was
approved, without another hidden-background attempt. Esc was verified to exit at
the sampled moments. A later read-only screenshot shows “远控已连接” on another
Home-screen page; it does not establish who re-entered, persistent idle or sustained
FPS. The service is available and default control is permitted.

Continuous high-frame-rate smoothness remains unaccepted (native capture cap
12.5 fps); real PointerLock in other browsers, long-running resources, AP/IP
recovery, rotation/STOP re-authorization and other phones remain unverified.

Code remains uncommitted/unpushed;
automation remains **PAUSED**.

<details>
<summary>Historical v7 relative input — window fallback function passed, high-FPS smoothness unaccepted</summary>

The following belongs to v7. Its start/capture controls and picture-leave exit
behavior do not describe the current v8 UX.

Checkpoint: **2026-10-17, v7 functionality PASS on this OnePlus/IAB window fallback;
high-frame-rate continuous smoothness NOT YET ACCEPTED**. The user
allows Android mouse acceleration and wants the computer cursor hidden, watching
only the real phone pointer in the video. Human control is therefore moving from
v6's timed coordinate targeting to continuous relative HID motion. The functional
checks below passed; they do not establish an overall high-FPS product acceptance.

Final root typecheck/build and diff check passed. `npm run test:android` passed
**231/231**, including **27/27 actual-operator VM cases**. Log:
`apps/android-mcp/build/host-relative-v7-tests.log`. Source is frozen.

| v7 direction and evidence | Status |
| --- | --- |
| Human mouse input | Implemented: animation-frame scheduling, accumulated relative MOVE deltas and at most one in-flight request, with ordered button/key edges |
| PointerLock | Actual IAB capture was not allowed (lock=null); window-contained relative fallback passed. Real PointerLock capture and other browsers remain unverified; only the optional capture button retries capture |
| Cursor presentation | Actual IAB after one ARM click: computed cursor=none while controlling, showing only the video's real phone pointer; cursor=default after Esc |
| First picture click | Actual PASS: with the real phone cursor already at the Home-screen “小工具” icon, the first picture click opened that folder without homing or swallowing the click; this is not mapping the webpage click position |
| Android acceleration | Allowed; human movement is relative, not an absolute browser-pixel → phone-pixel mapping |
| Human calibration, homing and timed coordinate positioning | Removed from the human path; no coordinate calibration, corner homing or 100 ms positioning timer |
| AI coordinate tools | Unchanged: explicit calibration, estimated positions, homing/pacing and screenshot guards remain |
| Pause/release behavior | Final reload → ARM → immediate Escape PASS, including pending ARM/capture: “已按 Esc 暂停，鼠标和键盘已松开”; later polling remained paused, cursor=default/errorVisible=false/lock=null. VM regressions cover capture loss, leaving window-mode image, blur, hidden/offline page and visual loss |
| Raw relative-path benchmark | Second isolated run completed: 32 MOVE requests, all HTTP 200, 3474 ms total, approximately 9.2 reports/s; ended paused |
| Raw movement with simultaneous PC SSE recording | 32 reports in 5722.64 ms; 40 received frames/36 image hashes; input ACK median 107 ms, p95 479 ms, maximum 714 ms |
| v7 acceptance boundary | Functional checks passed on the current OnePlus/IAB fallback; high-frame-rate continuous smoothness still needs acceptance |

Browser evidence: `operator-relative-v7-click.png` and
`operator-relative-v7-final.png`. `operator-relative-runtime-v7.json` records PID
**50580**, `runtimeVersion=3`, frozen hashes and the final BLE state:
connected/encrypted/bonded/ready=true, armed=false, locked=false. Operator JS SHA-256:
`478f28690ffe426421b2b6ac7b4d8c4857988b9006926286d913dd0e8ff18b10`.
The pending-ARM/capture Escape case first reproduced a failure, then passed after
the fix. The final screenshot shows the latest paused UI with the phone's
notification shade; the earlier click screenshot retains the folder-open evidence,
whose click code did not change in that last fix.
During preparation, BLE Back preceded the next visible screen update: an immediate
cached screenshot still showed the folder. The test waited until the real browser
showed Home, then performed the folder click; the earlier cache content was not
recorded as a Back failure.

The raw benchmark is request/report throughput, not end-to-end picture latency or
a browser smoothness result. Evidence:
`apps/android-mcp/build/device-tests/relative-hover-bench.json`, with before/after
JPEGs `relative-hover-before.jpg` and `relative-hover-after.jpg`. The first helper
attempt was cancelled while the user also controlled the UI and is kept separate;
it is not counted as a successful benchmark.

The simultaneous-video run is saved in
`apps/android-mcp/build/device-tests/relative-hover-video/result.json`. Its ACK
times are not picture latency. Parallel SSE recording and observed Wi-Fi jitter
affect this run; video capture is capped at 12.5 fps, so none of these figures
establish completely smooth control. Setup used an older MCP tap at (540,600),
which entered folder-title editing; no text was entered and the folder name was
unchanged. This setup action is not a v7 browser-control acceptance check.

This iteration changes the browser human-input path. The PC backend, ESP firmware
and phone APK hashes remain unchanged; no flashing or bond handling was performed. Prior v6
click/safety checks remain historical facts, while v6 continuous hover smoothness
failed and is not carried forward as a v7 smoothness pass. The final service is paused.

Source freshness remains three seconds including transfer; AI coordinate
snapshots remain valid for 30 seconds. Long-running resource pressure, deliberate
Wi-Fi AP loss/IP-change recovery, rotation/projection STOP/re-authorization and
other phones remain unverified. Code is uncommitted/unpushed; automation remains
**PAUSED**.

<details>
<summary>Historical v6 coordinate-target control — clicks/safety passed, continuous hover failed</summary>

The following belongs to v6's coordinate-target mouse mode. Its alignment,
calibration and 100 ms human-control descriptions do not apply to v7's relative
human mouse; AI coordinate tools retain their own existing pacing.

Checkpoint: **2026-10-17, v6 IN PROGRESS; continuous hover smoothness NOT ACCEPTED**. Clicking ARM now
automatically starts direct control of the displayed phone image: hover positions
and clicks map to phone pixels, without a second remote-control button or
PointerLock. This replaces v5's relative window-mode interaction; the earlier
transport/hardware evidence is retained below.

The current service is PID **50580**, with `runtimeVersion=3`. ESP Wi-Fi firmware
remains `8b602a11edf74f123183cd70caa1d5fc6413538dd564259753934ad793aa2f42`;
no new firmware flash was performed for v6.

Final host gate: **226/226 Android tests PASS**, including **22/22 actual-operator
VM cases** with `preventScroll`. Evidence:
`apps/android-mcp/build/host-direct-release-tests.log`. The old poll/refresh failure
races first reproduced three failing checks; after the fix, all four new regression
cases passed. This gate precedes the latest hover-smoothness feedback and does not
establish acceptance of that issue.

| v6 direct-control check | Result |
| --- | --- |
| ARM starts direct image control | PASS in the real IAB after reload; one ARM click, no second remote button or PointerLock step |
| Display-to-phone mapping and input ordering | Host PASS; 270×600 display → 1080×2400 phone, ordered down/up and other edges, merged hover targets instead of a movement backlog |
| Actual Wi-Fi pointer targets | Three HTTP 200 results: (540,1200), (665,1200), (675,1210), taking approximately 3869/393/371 ms |
| JPEG pointer-position comparison | Initial centroid (541.1,1201.46), final (674.92,1212.02), approximately 2 px error against the corresponding targets on this phone |
| Actual IAB direct click | PASS: ARM → native first-hover alignment → direct image click opened the intended “小工具” folder, observed in the tool screenshot |
| Continuous hover smoothness | NOT ACCEPTED; the user reports visible pointer jumps and stuttering during hover; improvement and renewed acceptance are required |
| Old poll/refresh STATUS failure racing with new ARM or normal Esc pause | FIXED; epoch/revision guards and four new regressions prevent stale failure callbacks from affecting a newer control round while preserving real same-round errors |
| Leaving the picture | Real IAB PASS; clean pause without an error |
| Final real Esc verification | PASS; explicit ARM then Escape displayed “已按Esc暂停，鼠标和键盘已松开”, no error; later status polling did not overwrite it |

The pointer comparison used thresholded JPEG differences and the circular pointer
ring centroid. It is an approximate observation for this OnePlus and its current
settings, not a device-independent calibration guarantee. First alignment still
took about 3.869 s; short subsequent moves took about 0.4 s.

The first hover after ARM aligns the phone pointer. Wait for the interface to say
alignment is complete before clicking: clicks during alignment are intentionally
ignored, with a waiting message, to avoid sending a click to the wrong position.
This is not zero-latency input or a promise of universal pixel precision.

A raw faster-motion experiment drifted: after 350 ms idle, a 125-count move
produced about 175 pixels; after 700 ms idle, 125 counts matched the expected
distance. The implementation therefore retains the established 100 ms gap after
each ACK. No general faster-control claim is made from this experiment.

Evidence under `apps/android-mcp/build/device-tests/`:

- `pointer-direct-device.json`: three acknowledged real targets, timings and final paused status for that isolated test.
- `pointer-direct-1.jpg`, `pointer-direct-2.jpg`, `pointer-direct-3.jpg` and `pointer-direct-final.jpg`: real JPEG pointer evidence.
- `operator-direct-folder-open.png`: actual browser folder-open observation.
- `operator-direct-final-runtime.json`: final runtime version/PID, frozen source hashes, gate counts and observed checks.
- `operator-direct-final.png`: final post-fix browser capture.

The recorded click and safety checks remain valid, but continuous hover smoothness
has not passed, so overall direct control is not ready for acceptance. The previous
acceptance ended paused with continuous video available. Long-running resource pressure, deliberate Wi-Fi AP
loss/IP-change recovery, rotation/projection STOP/re-authorization and other
Android manufacturers also remain NOT RUN. Source freshness remains three seconds
including transfer, and coordinate snapshot validity remains 30 seconds.

Code remains uncommitted/unpushed; automation remains **PAUSED**.

<details>
<summary>Historical v5 Wi-Fi/stream checks and earlier relative-control UX</summary>

The following records belong to v5. Its relative window-mode descriptions do not
describe the current v6 direct-control UI.

Checkpoint: **2026-10-17, v5 transport/hardware core PASS; direct-control UX IN PROGRESS**.
The OnePlus sends continuous MJPEG over LAN, MCP reads validated cached frames,
and the PC now controls the real ESP over Wi-Fi TCP, with BLE HID to the phone.
New firmware is built and flashed; board-side Wi-Fi selection/password entry and
the control-source lease have physical evidence. Actual browser window-contained
mouse/keyboard events, physical stop recovery and Wi-Fi coordinate calibration
passed on this phone. However, the user then reported that starting control did
not allow direct image clicks or following hover movement. The relative window
fallback does not meet that expected flow; default direct hover/click and correct
mapping are being revised. Full remote-control acceptance is pending. The v4
record remains historical USB-path evidence.

Latest completed PC checks before the new direct-control UX revision: **PASS** —
`npm run typecheck`, `npm run build` and
`npm run test:android` (**195/195**, including **17/17** actual-operator VM tests
and 11 HTTP input cases for slow request bodies crossing ARM and stale callbacks
affecting newer control sessions). Log: `apps/android-mcp/build/host-stream-final-tests.log`.
Native production FrameServer/FrameStore socket tests: **10/10 PASS**.
New ESP complete firmware gate: **PASS**, including **18 C programs** and
**121 Python checks**. Partitioned flashing passed while preserving NVS.

| Current upgrade check | Result |
| --- | --- |
| New MJPEG APK on OnePlus 8 / IN2010, Android 13 | PASS; installed over the previous APK, user started projection; hash below |
| Actual phone LAN `/stream.mjpg` | PASS; one HTTP GET over 25.011 s, 58 complete 1080×2400 frames, 58 source IDs, 32 image hashes, zero errors |
| Stream freshness and throughput | Maximum validated source age 617 ms including transfer; peak 12 frames in one dynamic second, not a sustained 12 fps claim |
| Thirty direct latest-frame cache reads | PASS; maximum 0.0301 ms for the local cache method only |
| Official in-memory SDK using actual phone LAN video | PASS; 30 images, cache-hit call median 2.0485 ms/max 7.8379 ms; input mocked, zero input reports |
| New HTTP screen path, read-only SDK and SSE check | PASS; 10/10 JPEG snapshots with 10 MCP frame IDs/6 source IDs; call median 3.496 ms/max 8.986 ms. Over 10 s, SSE delivered 10 complete frames/10 source IDs, final source age max 486 ms, zero errors |
| Board Wi-Fi list and on-screen password keyboard | PASS; user configured Wi-Fi on the board; read-only USB status confirmed configured/connected=true and TCP at 10.65.201.147:3333 |
| BLE after NVS-preserving firmware flash | PASS; automatically restored connected/encrypted/bonded/ready=true |
| Actual TCP → ESP → BLE HID | PASS; MOVE (12,-8), reverse movement and neutral KEY; before/after LAN images showed the pointer |
| 1500 ms control lease without PING | PASS; at approximately 1850 ms the old socket was closed and a new STATUS reported armed=false |
| Active TCP socket disconnect | PASS; STATUS after 200 ms reported armed=false |
| Official MCP over HTTP plus Wi-Fi ESP | PASS; Home 93 ms, Tab 320 ms, Back 160 ms, PAUSE 302 ms; snapshots 4/4/5 ms; final state paused |
| Final-service direct `/remote/input` over Wi-Fi | PASS; mouse (4,-4), Tab down and key release all HTTP 200, taking 197.59/222.51/21.925 ms; deleting the lease left armed=false/locked=false/ready=true |
| Current firmware physical DOWN/OK | PASS; DOWN set locked=true/armed=false and ARM returned LOCKED; after the user pressed OK, the real browser showed unlocked/paused and explicit ARM succeeded |
| Prior browser window-contained relative-control checks | Observed PASS: image click, Tab and a short drag affected the phone; Esc and leaving the image paused control. These checks do not establish the newly requested direct-control UX |
| Direct image hover/click immediately after starting control | IN PROGRESS; user reported clicks and hover following do not work as expected; default interaction and mapping need correction and renewed acceptance |
| PointerLock compatibility | IAB Chromium still rejects PointerLock; the tested window-contained fallback supports this browser. Other browsers are not claimed verified |
| AI coordinate calibration using Wi-Fi | PASS at 1:1: taps (540,1200) and (550,1210) matched the circular pointer in JPEG images; first placement 5062 ms, nearby second placement 522 ms |
| Long-running Wi-Fi/BLE pressure/resource headroom, deliberate AP loss/IP-change recovery, rotation, projection STOP/re-authorization and other Android manufacturers | NOT RUN |

The pure cache figures exclude capture, JPEG encoding and LAN delivery. In-memory
SDK cache-hit figures exclude the initial cold read and use mocked input. Local
HTTP SDK figures include HTTP transport, server cache retrieval/serialization and
client HTTP/JSON/SDK processing; they are not pure cache timings or end-to-end
visual latency. Its conservative source age including the full RPC was at most
1245.58 ms. SSE source age includes same-PC delivery measured using `sentAt`.
Unlike the in-memory test, the later official HTTP/Wi-Fi core run used real input.
First Wi-Fi coordinate placement was slow at 5.062 s; the nearby second tap took
0.522 s. These observations do not establish uniformly faster control than USB.

Evidence under `apps/android-mcp/build/device-tests/`:

- `oneplus-stream-v5.json`: single-GET phone stream and 30 direct cache reads.
- `oneplus-stream-sdk-v5.json`: real LAN video/in-memory SDK with zero input reports.
- `operator-stream-http-v5.json`: bounded read-only HTTP SDK/SSE check; SDK closed afterward, service remained running.
- `esp-wifi-configured.json`: read-only USB STATUS/WIFI_STATUS; no PING or input.
- `esp-wifi-device-v5.json`: real TCP movement, lease expiry and disconnect disarming.
- `oneplus-wifi-core.actions.json.results.json`: successful official MCP/HTTP/Wi-Fi hardware actions.
- `operator-final-remote-v5.json`: post-restart real `/remote/input` and lease-release state.
- `physical-stop-wifi-v5.json`: current Wi-Fi firmware physical DOWN lock and ARM rejection; OK recovery was then verified in the actual browser.
- `oneplus-wifi-calibration.actions.json.results.json`: real Wi-Fi 1:1 calibration, both coordinate taps and final pause.
- `operator-stream-wifi-final.png`: final browser capture of the continuous Wi-Fi operator.
- `oneplus-stream-motion.actions.json.results.json`: earlier stream-period motion using the previous USB service/firmware.

Two invalid test attempts remain as separate evidence, not product failures:
`esp-wifi-device-invalid-test-command.json` used MOUSE instead of MOVE;
`oneplus-wifi-core-invalid-test-argument.json` used key instead of combo for
android_key. Corrected runs passed.

Installed stream APK SHA-256:
`0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`.
Installed Wi-Fi firmware merged-image SHA-256:
`8b602a11edf74f123183cd70caa1d5fc6413538dd564259753934ad793aa2f42`.
Matching ELF SHA-256:
`e2aadeae7e66e7a9f93aa46e00ddd79484367f1572cbeda76f674c0d6fd8d72a`.
The local artifact hashes were checked. The earlier `eee6…` image belongs to the
v4 history below and is not the active Wi-Fi firmware.

The final Wi-Fi HTTP service is running as PID **42880**, using
`ESP_HOST=10.65.201.147` and TCP port 3333; health reports `runtimeVersion=2` and the
service does not occupy COM5. Restart used exact-process verification within the
same PowerShell session following explicit user authorization; the earlier
automatic approval rejection is historical. The final server is left paused.
Transport/hardware checks remain passed, but direct-control UX must be corrected
and retested before full remote-control acceptance. The NOT RUN row also defines
remaining coverage limits.

Code remains on `codex/android-agent`, uncommitted and unpushed. Automation remains
**PAUSED**. Source freshness stays limited to three seconds including transfer,
coordinate snapshots to 30 seconds; neither limit was relaxed.

<details>
<summary>Historical v4 acceptance — earlier USB ESP firmware and HTTP operator</summary>

The following is the previous checkpoint, retained as historical evidence. Its
“current” labels refer to v4 rather than the active v5 build.

Checkpoint: **2026-10-17**. The installed Android MediaProjection App shares
original-resolution JPEG images over the private Wi-Fi LAN. The PC provides MCP
images and tools, and connects over USB serial to the ESP32-C3 BLE keyboard/mouse.
Phone USB and ADB are unnecessary at runtime. The App and local MCP HTTP service
require no token or Authorization header; MCP HTTP remains bound to loopback with
Host/Origin checks.

Build and host checks: **PASS** — `npm run typecheck`, `npm run build`,
`npm run test:android` (**144/144**) and `npm test` (**35/35**).
The complete isolated ESP-IDF firmware gate passed, including **14 C programs**
and **116 Python checks**. The APK passed v2/v3 signature verification.
Host regressions cover official SDK session cleanup, cancellation, frame guards,
JPEG dimensions/truncation, cold serial handshakes and operator asynchronous races.
Coordinate actions recheck their frame when leaving the queue. Source age remains
limited to three seconds including transfer, and coordinate frames to 30 seconds.

Core hackathon demonstration: **PASS** on the physical **OnePlus 8 / IN2010,
Android 13**, using LAN/JPEG → MCP → BLE HID. This checkpoint does not cover every
recovery path or Android manufacturer.

| Current device checks | Result |
| --- | --- |
| Signed no-token JPEG APK installation and system projection consent | PASS; installed APK matches the hash below, and the user confirmed projection consent |
| Actual phone LAN screen → receiver → native MCP image/operator | PASS; original 1080×2400 `image/jpeg`; works with phone USB disconnected |
| No-token transport | PASS; `/frame.jpg` returns 200 without Authorization, obsolete `/frame.png` returns 404 |
| BLE encrypted/bonded/HID-ready connection, Home, HID input and pause | PASS for observed actions |
| Chinese LCD text on the current firmware | User confirmed correct display without garbled characters; the agent did not visually inspect the physical LCD |
| Desktop idle for 16 s, then 30 sequential captures at 1 s intervals | PASS; 30/30 fresh, 30 distinct source frames, no timeout or stale rejection; detailed statistics below |
| Repeated calibrated point-and-click on the current Chinese firmware | PASS; in one official HTTP MCP session at 1:1 calibration: (540,1200) took 1859 ms, then (550,1210) took 188 ms and (560,1220) took 169 ms; JPEG images confirmed each pointer position, followed by PAUSE |
| Physical DOWN lock, ARM rejection and board OK recovery on the current Chinese firmware | PASS; DOWN set locked=true/armed=false, ARM returned LOCKED; the user pressed OK, subsequent explicit ARM/Home succeeded, and official SDK status confirmed locked=false |
| Actual browser operator responsiveness and final pause | PASS; automatic connection without a token field, explicit ARM, Home remained enabled and succeeded during background capture, then UI pause/release succeeded |
| Current APK runtime rotation, STOP and renewed projection consent | NOT RUN; earlier emulator attempts were rejected by automatic approval review with “blocked by policy”; no current physical acceptance is claimed |
| Wi-Fi loss/recovery, IP address changes, ESP USB unplug/recovery, other Android manufacturers | Unverified on the current build |

The desktop JPEG run used the APK hash below and retained the default 3000 ms
freshness limit, with body transfer included. All 30 images passed JPEG
SOF/segment/SOS/terminal-EOI structure checks and retained 1080×2400 dimensions.
There were two content hashes on the static desktop, with 30 distinct App source
frame IDs; freshness was not manufactured from HTTP response time.

| Desktop JPEG metric | Minimum | Upper median | Maximum |
| --- | ---: | ---: | ---: |
| Frame bytes | 197672 | 197691 | 197691 |
| Source age at HTTP headers (ms) | 50 | 624 | 1065 |
| Final source age including body transfer (ms) | 99 | 703 | 1260 |
| Capture request duration (ms) | 131 | 240 | 589 |

The upper median is the 16th sorted sample of 30, matching the saved JSON summary.

Local evidence: `apps/android-mcp/build/device-tests/oneplus-wallpaper-jpeg-v4.json`
and `oneplus-wallpaper-jpeg-v4-last.jpg`. Repeated-tap evidence:
`oneplus-chinese-nearby.actions.json.results.json` and `oneplus-chinese-tap-*.jpg`
in the same directory. Earlier PNG and emulator records remain historical evidence;
their token/401 checks are not the current product contract. Current physical-stop
evidence is `oneplus-chinese-physical-stop.json`. Browser evidence is
`operator-no-token-final.json` and `operator-no-token-final.png`; subsequent
`oneplus-chinese-recovery.actions.json.results.json` confirms encrypted/bonded/ready,
locked=false/armed=false, a valid real JPEG and final PAUSE.

Earlier physical checks confirmed MITM pairing, 100 ms mouse pacing and watchdog
disarming after 1.8 s without PING. These do not replace current-build recovery tests.

Current Chinese firmware full-image SHA-256:
`eee6d19893483eb6ad38e64cfe280fa607ec17ad060818be9ab4fc314c40dcb1`.
Matching ELF SHA-256:
`8c7c575762bd9f596a4a93f3f6a7bda665650f7f133aeb6747c00444d84b1775`.
Verified component images were flashed on COM5 at 0x0, 0x8000 and 0x10000,
preserving the NVS range and BLE bond; no whole-chip erase was performed.

Installed signed APK SHA-256:
`94458e41878fdaac309e6103ab0080504aa1e46a48e557e947a38f790539da89`.
Firmware artifacts are under `apps/esp/build/firmware/<hash>/`; APK artifacts are
under `apps/android-screen/build/`. Logs, captures, local configuration and signing
keys remain Git-ignored.

The running local MCP service includes the no-token/JPEG/operator/input changes.
The latest serial cold-connect fix is compiled and host-tested: only the first
neutral handshake PING may retry once after an ACK timeout; input and ARM never
retry. It will take effect on the next service restart. Automatic approval review
rejected this round's local MCP restart, so activation in the running process has
not been claimed or worked around.

The code is on `codex/android-agent`; this increment has not been committed or
pushed. The scheduled automation is **PAUSED**. Remaining physical checks are the
not-run/unverified rows above.

</details>

</details>

</details>

</details>

</details>
