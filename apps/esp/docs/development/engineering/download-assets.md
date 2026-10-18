<p align="right"><a href="download-assets.zh_CN.md">简体中文</a> · <strong>English</strong></p>

# Driver download resources

The controller's root page at `http://<device-IP>:3334/` offers three manual
steps: connect to the same wireless network, download, then install/open.
The ESP, computer and controlled phone are clients of that network.
Internet access is unnecessary. Previous/next navigation does not start a
transfer, pair Bluetooth or claim installation success. Windows defaults to the
native single-request `/qdd-desktop.zip` download; Android defaults to
`/qdd-remote.apk`. Both platform links remain available. The browser download
list is the source of completion evidence; only the user advances to install.
The ZIP contains one Windows x64 executable: extract it before opening.

The primary flow downloads directly in the browser over the LAN; it does not
ask users to save a local HTML file or choose a USB serial port. The old USB
attachment endpoints remain for compatibility, outside the ordinary guide and settings.
The legacy USB page has preparation, receive and save steps; protocol/checksum details
are collapsed. Plain HTTP cannot use Web Serial: save the self-contained HTML
and open it in desktop Chrome/Edge. Transfer requires an explicit click and
port selection. Navigation is disabled while receiving, cancellation closes
the port, and saving requires complete SHA-256 verification.

Boards with an `assets` partition continue to use that resource exclusively.
An existing corrupt partition fails explicitly. Boards without `assets`, such
as the current COM5 factory layout, use a verified ZIP embedded in application
Flash. `tools/prepare_desktop_zip.py` verifies the v50 manifest, ZIP contents and
extracted EXE identity. The fallback adds 943,153 Flash bytes, reuses the 2 KiB
read/hash buffer, and does not repartition or load the entire ZIP into RAM.
The application must still fit the actual target app partition.

## Browser USB receiver build

After installing the locked npm dependencies, run from the repository root:

```powershell
node apps/android-mcp-rust/tools/prepare-usb-receiver.mjs
node apps/android-mcp-rust/tools/test-usb-receiver.mjs
```

Outputs are the manifest-named HTML and `manifest.json` under
`apps/android-mcp-rust/build/usb-browser/v55/`. The page embeds all JS/CSS, minified with pinned esbuild, without
CDN, external fonts or network scripts. `tools/prepare_usb_receiver.py` checks
source/output identity, UTF-8, size and external-resource restrictions before
generating deterministic gzip Flash bytes. HTTP neither decompresses them nor
copies the complete page into RAM. `/qdd-usb-receiver.html` saves the legacy HTML
as an attachment. The old browsable `/usb-receiver` path redirects with HTTP 307
to the same-origin root page; request arguments cannot change the destination.
The HTTP page disables connection and explains saving. The local page still
checks secure context, Web Serial and WebCrypto. Port selection requires a user
click, accepts only VID 303A/PID 1001, and does not set DTR/RTS. Only read-only file
blocks are retried, with per-block CRC/session/offset checks and whole-ZIP SHA
verification before showing Save. Cancellation, disconnect and failure close
the port; there are no HID, reset or flash actions.

Obtaining the HTML initially still requires the existing web page connection or
a previously distributed file. It is not a mounted drive and does not grant
serial permission to ordinary HTTP. Browser support and real USB transfer need
separate device verification.

## Legacy native USB downloader build

The old `/qdd-usb-installer.exe` endpoint remains compatible but is no longer the
primary Windows entry on the download page.

Before building firmware, build the Windows x64 helper from the repository root
with Node 24 and an installed MinGW-w64 x64 compiler:

```powershell
$env:QDD_USB_CC = 'C:/path/to/x86_64-w64-mingw32-gcc.exe'
node apps/android-mcp-rust/tools/usb-driver/build.mjs
```

This produces the manifest-declared executable and its manifest under
`apps/android-mcp-rust/build/usb-driver/v52/`. `tools/prepare_usb_installer.py` checks the exact PE x64 image,
128 KiB size limit, thirteen source identities and executable digest before
generating the deterministic gzip payload and C header for firmware. Source
drift or an absent helper fails the firmware build rather than embedding an old
binary. HTTP streams those Flash bytes with `Content-Encoding: gzip`, an EXE
attachment filename and the decoded EXE SHA header; the ESP does not decompress
them. This is separate from the original ZIP stored in `assets`.

The helper lists only matching VID 303A / PID 1001 COM devices, requires an
explicit selection when multiple boards are present, disables DTR/RTS, and uses
an exclusive serial handle. It writes a new temporary file, checks the complete
ZIP digest, then renames without overwriting existing files. Cancellation,
timeouts and invalid data remove the incomplete file and close the handle.
Source and host tests describe intended behavior; real transfer speed, driver
behavior and board memory remain separate device checks.

The repository's default minimal partition table is unchanged. An optional
`assets` data partition overrides the embedded Windows ZIP. With no such
partition, the application serves its verified embedded ZIP. Malformed or
corrupt selected resources return HTTP 503 without blocking the embedded APK.
Completing a Windows download does not advance the phone APK installation milestone.

## Resource image

`tools/pack_download_assets.py` creates a standalone image; it neither accesses
a device nor flashes or merges firmware. The image contains a 64-byte
little-endian header, `0xff` padding to 4096 bytes, then the original EXE or ZIP.
`QDDDRV1` retains raw-EXE compatibility. `QDDDRV2` stores ZIP bytes and is rejected
by old firmware; never replace a raw EXE with ZIP bytes under a v1 header.

| Byte offset | Size | Value |
| ---: | ---: | --- |
| 0 | 8 | `QDDDRV1` or `QDDDRV2` followed by NUL |
| 8 | 4 | Format version, 1 for EXE or 2 for ZIP |
| 12 | 4 | Payload offset, 4096 |
| 16 | 4 | Stored payload byte length (compressed ZIP length for v2) |
| 20 | 4 | Kind: 0 for v1 EXE, 1 for v2 ZIP |
| 24 | 32 | SHA-256 of the stored payload |
| 56 | 8 | Reserved, zero |

From `apps/esp`, use an independently read, MD5-validated target partition
table and the final Rust build manifest:

```powershell
$driverManifest = Get-Content -LiteralPath ../android-mcp-rust/build/windows/v47/manifest.json -Raw | ConvertFrom-Json
$driverZip = (Resolve-Path -LiteralPath (Join-Path ../android-mcp-rust/build/windows/v47 ([IO.Path]::ChangeExtension($driverManifest.executable, '.zip')))).Path
python tools/pack_download_assets.py create --zip $driverZip --exe-manifest ../android-mcp-rust/build/windows/v47/manifest.json --partition-table build/target-partition-table.bin --output build/driver-assets.bin
python tools/pack_download_assets.py verify --exe-manifest ../android-mcp-rust/build/windows/v47/manifest.json --partition-table build/target-partition-table.bin --output build/driver-assets.bin
```

`create --exe <path>` remains available for v1; `--exe` and `--zip` are mutually
exclusive. `verify` detects the format from the saved resource image.
For ZIP, the host tool requires the single UTF-8 executable name declared by
the package contract and manifest, matching manifest
ZIP size/hash, valid CRC and exact decompressed EXE size/hash/PE x64 identity.
Extraction is bounded to 16 MiB and the declared EXE size; extra/path entries,
encrypted entries, non-file modes and unsupported compression are rejected.

The tool checks table integrity, uniqueness, alignment, overlap and capacity,
PE x64 identity, exact manifest byte count and hash, resource header, payload
digest, and the sector-rounded erase range. It saves the exact image identity,
build ID, separate EXE/payload identities, target offset, capacity and erase end
in `driver-assets.json`. An oversized stored payload fails; it never resizes partitions. Writing the resource is
a separate authorized device operation using the actual target table and the
exact verified image. Never write it at zero or as a merged firmware image.

## Runtime and verification boundary

One low-priority worker validates the complete payload with a 2 KiB read buffer
before sending a successful response. It then reads and sends bounded chunks
with a fixed `Content-Length`, attachment filename and SHA-256 response header.
Hashing and transmission share that same staging buffer. The complete
payload is never loaded into RAM or mapped into virtual memory. ZIP is sent as
its original compressed bytes; the ESP does not decompress it or use HTTP
content encoding. ZIP responses use `application/zip`, a `.zip` attachment,
compressed byte count and `X-QDD-ZIP-SHA256`. Raw v1 resources retain the EXE
MIME, filename and `X-QDD-EXE-SHA256` at `/qdd-desktop.exe`; if that old URL is
requested with a ZIP resource, validation is followed by a 307 redirect to the
ZIP URL instead of mislabeled file bytes. A ZIP URL with only a v1 resource
returns 503 and identifies the legacy EXE URL.

The worker owns an asynchronous HTTPD request, so a slow Windows transfer does not
occupy the ordinary status/phone/PC registration worker. Concurrent Windows
downloads receive 503 and can retry after the first transfer finishes. A Wi-Fi
epoch change cancels the transfer and waits for asynchronous request completion
before stopping its HTTPD instance. Read/send errors close the incomplete
session, and every asynchronous request is completed exactly once.

`GET /api/download-status` publishes a separate, at-most-256-byte diagnostic
snapshot without enlarging the ordinary status/discovery packet. It records
`busy`, `phase`, start/after-verification/minimum/end heap, minimum largest
block, successfully sent body bytes, result and socket errno. Header bytes do
not count as body progress. Phases 1–5 mean begin, verified, sending, completing,
and finished. The end-heap sample follows asynchronous request completion but
precedes worker self-deletion; an independent later sample is needed to check
the task-stack release. This evidence identifies memory pressure without
claiming that a fixed buffer saving proves or repairs an unrelated leak.

The complete static gate includes `test_qdd_download_assets.c`, production
onboarding handler/lifecycle tests, and `test_pack_download_assets.py`.
Those checks cover format/range/hash rejection, partial sends, unavailable
resources, platform links, busy/task failures, registration while a download
is pending, and network cancellation. Real board download hashes and browser
behavior remain separate device checks; build/host success is not device
acceptance. Compression reduces transmitted bytes but does not establish that
an existing network timeout or truncation is fixed. Wireless settings, native
send deadlines and ACK/watchdog limits remain unchanged.

## Bounded ZIP ranges and browser download

After full resource validation, ZIP responses expose a strong `ETag` containing
the quoted complete ZIP SHA-256 and `Accept-Ranges: bytes`. A single explicit
`Range: bytes=start-end` returns 206 with the exact segment `Content-Length`
and `Content-Range: bytes start-end/size`; the SHA header always identifies the
whole ZIP. Both endpoints must be unsigned decimal integers with
`start <= end < size`. Suffix/open/multiple ranges, overflow and malformed or
oversized values return 416 with `Content-Range: bytes */size`.

Only `bytes=0-0` without `If-Match` is a metadata bootstrap. It returns one byte
that the browser discards. All other ranges require `If-Match` equal to the
quoted full-file ETag; missing, weak or mismatched values return 412 without
file bytes. A supplied `If-Match` on bootstrap or a full ZIP request must also
match. Every request revalidates the full resource hash; no hash cache is used.
Range responses reuse the same worker/buffer and cleanup path. The original
no-Range response remains a complete 200 download; legacy EXE redirects remain.

The external module at `/driver-download.js` starts only when the dedicated
`data-driver-resume` fallback link is clicked; ordinary ZIP and APK links keep
their native browser behavior. The default ZIP request uses the existing full
200 response, without a metadata bootstrap or application-level split. The
explicit fallback requests sequential 8 KiB
ranges, retries only the current file segment within bounded attempt and total
time limits, and offers progress/cancel/restart controls. It verifies each
response's range, length, ETag and complete-file SHA identity, then computes the
final ZIP SHA before creating a saved file. A failed/incomplete segment is not
appended; this never retries device-control input. Actual browser/network
recovery and the final ZIP CRC/EXE identity still require device acceptance.

`tools/prepare_driver_script.py` generates a deterministic gzip module during
CMake configuration using the activated IDF Python. The original UTF-8 script
is bounded to 32 KiB, recorded with its compressed size/hash, and embedded as
Flash bytes. HTTP serves it with JavaScript MIME and `Content-Encoding: gzip`;
the browser decompresses it, with no ESP decompression or full RAM copy. The
page permits only same-origin external scripts and connections. Host checks
include `test_driver_download.mjs` and `test_prepare_driver_script.py`.

## Failed allocation caller probe

The neutral USB-only command `QDDNET/1 <id> OOM_TRACE` returns a separate,
at-most-128-byte numeric record of the first failed wrapped allocation in this
boot. It is diagnostic code-address data, not a heap address or stack dump;
keep device evidence in ignored build outputs. `kind` is 1 for malloc, 2 for
calloc, 3 for heap_caps_malloc; `caps` is zero when the public API has no caps
argument. `count` counts wrapped nonzero requests returning NULL, not SDK hook
calls. Three noinline IRAM wrappers call the original allocator once, preserve
arguments/results/errno, and record only after NULL. Zero-byte NULL results are
ignored; a calloc size overflow is represented by the saturated size.

GNU ld wraps unresolved references, including the Wi-Fi adapter's allocator
function pointers. Same-object allocator calls, other allocation APIs and
opaque ROM paths are not a complete tracing surface. The SDK first-OOM callback
runs inside the real allocation before a wrapper sees its result; the first
records and counts may therefore differ. Decode the caller return PC (and the
preceding instruction if needed) only against the exact flashed ELF. A caller
location alone does not establish a leak, its lifetime, or a complete stack.
No allocator behavior, resource guard, wireless setting, ACK/watchdog or native
HTTP deadline is changed by this probe.

## Offline LAN installation and legacy USB protocol

After the button guide, onboarding offers six manually navigated pages: wireless
network, computer download, phone installation, Bluetooth pairing, projection,
and actual connection status. The computer opens `http://<device-IP>:3334/` on
the same LAN and downloads the ZIP directly; the phone QR opens the same page
with an APK recommendation. Previous/next never imply installation success,
start a scan or pair Bluetooth. Confirmation on the relevant page starts those
actions. Connection changes do not take over the user's current page.
Settings list driver download, wireless network, phone Bluetooth pairing, button
guide and reset. The legacy USB page is no longer selectable there.

The following protocol remains compatible with previously saved USB receivers.

The UI reads a locked, fixed-size worker snapshot: idle, checking, transferring,
sent, cancelled or error. Progress counts only the contiguous prefix of fully
transmitted READ replies. Repeated ranges do not add bytes and a tail-only
read cannot report completion. SENT means the ESP transmitted all bytes, not
that the computer saved, validated, extracted or installed them; it never
advances onboarding automatically. A successful final CANCEL retains SENT,
while a partial cancellation remains visible. The snapshot never changes
control ownership, pairing, protocol replies or the safety deadlines.

`QDDDRV/1` reads the verified ZIP resource through the application's USB serial
port. It does not enter the bootloader, write Flash, erase NVS, authorize HID,
or transfer screen/input data. TCP requests receive `USB_ONLY`. The board
rejects admission while armed or while any USB/TCP control owner is active,
including a neutral PING owner. An accepted INFO immediately reserves a
read-only session before the next input line can establish a controller.
During that reservation new PING/ARM, text changes and network configuration
writes receive `CONTROL_BUSY`; neutral status, PAUSE and RELEASE remain safe.
HTTP Windows downloads and a USB session share nonblocking resource admission,
so their large-transfer workers cannot overlap.

Every command is an ASCII line ending in LF. Request IDs are positive decimal
uint32 values; session tokens are nonzero, exactly 16 lowercase hexadecimal
characters. SHA-256 and CRC fields use lowercase hexadecimal. The grammar is:

```text
QDDDRV/1 <id> INFO
QDDDRV/1 <id> INFO <session> <ZIP-size> <ZIP-sha256> ZIP
QDDDRV/1 <id> READ <session> <offset> <length>
QDDDRV/1 <id> DATA <session> <offset> <length> <CRC32> <hex-bytes>
QDDDRV/1 <id> CANCEL <session>
QDDDRV/1 <id> OK
QDDDRV/1 <id> ERR <code>
```

INFO validates the complete stored ZIP SHA once, then binds a fresh session to
the current boot/resource. READ accepts 1..1024 bytes with an explicit offset
and subtraction-checked bounds. It never advances an implicit cursor; rereading
the same offset returns identical bytes. CRC32 is IEEE/zlib CRC32 of the raw
bytes (initial value zero), formatted as eight hex digits. DATA has exactly
twice `length` hex characters. The receiver must verify the complete ZIP SHA
before enabling file saving. The asset packer and device-download acceptance
separately check ZIP CRC and contained EXE identity; the browser receiver does
not parse or execute the EXE.
Raw v1 EXE resources are intentionally not offered by this ZIP protocol.

The idle session expires after strictly more than 60 seconds without a
successful INFO/READ, on clock rollback, confirmed USB loss, active control,
I/O failure or CANCEL. INFO replaces an older idle session. Errors include
`BAD_COMMAND`, `USB_ONLY`, `CONTROL_BUSY`, `BUSY`, `STALE_SESSION`, `BAD_RANGE`,
`ASSET_ERROR` and `IO_ERROR`. Bad offset/session requests return errors without
changing a still-valid session. I/O/hash failure releases admission; a client
must not append bytes from another resource identity. A matching CANCEL can
interrupt an in-flight READ; an unknown INFO session ends after physical USB
disconnection, a failed transfer, or idle expiry. Merely closing a Windows COM
handle does not prove that the USB peripheral has disconnected.

Hashing and reads reuse one 2 KiB static staging buffer; a separate bounded
2304-byte ASCII frame is never a whole-ZIP copy. One 4 KiB-stack worker is the
sole USB writer after startup and also serializes the main loop's two-slot
ordinary-reply queue. DATA uses native writes of at most 256 bytes because the
USB TX ring is 1024 bytes. Its total TX attempt is bounded to 2 seconds;
ordinary control replies retain the original 10 ms native write budget and
publish a failed-TX notification for the safety loop to release USB ownership.
No Flash read, hash, or USB write blocks the main safety loop. The original
1200 ms ACK, 1500 ms watchdog and HTTP deadlines remain unchanged.

Host coverage includes strict parsing/CRC/bounded formatting, admission before
the next line, repeated offset reads, malformed/overflowing ranges, single
writer ordering, cancellation, failed reads/TX, TTL/rollback/disconnect cleanup
and main-loop USB-only/control gates. These checks do not establish actual USB
throughput or reliable full-file transfer; hardware acceptance must verify the
final ZIP SHA and clean session release on the exact flashed build.

