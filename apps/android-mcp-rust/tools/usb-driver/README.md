# Offline Windows USB package downloader

The small native `设备USB下载器.exe` reads the ZIP stored in the controller's
existing assets partition. Running the helper requires only Windows system DLLs;
Node, Python, .NET, an execution-policy change and an ADB connection are not used.
It does not install/run the downloaded console, stop an existing service, send
phone input, erase Flash or change pairing.

Double-click to select the ESP USB device and a new ZIP output path. Only present
COM devices whose hardware ID has the exact `USB\VID_303A&PID_1001` components are
offered. Multiple boards require explicit selection. The device instance ID is
shown; COM numbers are not permanently assigned. The CLI accepts an exact path:

```powershell
.\设备USB下载器.exe --list
.\设备USB下载器.exe --port COM6 --output 'C:\Downloads\设备操作台.zip'
.\设备USB下载器.exe --self-test
```

The helper opens only the selected matching port, disables DTR/RTS immediately
and in the DCB, and uses exclusive access. Physical no-reset behavior still needs
on-device verification. Close other serial monitors first. `Ctrl+C` cancels.
An existing output is never overwritten. Accepted bytes stream to a unique
`.tmp` created with `CREATE_NEW`; block CRC and final Windows BCrypt SHA-256 must
pass, then FlushFileBuffers and same-directory no-replace MoveFileEx publish the
ZIP. Failed/cancelled runs close COM and delete only their own temporary file;
an exceptional cleanup failure is reported with its path. The helper never
automatically extracts or runs the main EXE.

`QDDDRV/1` uses positive decimal request IDs, nonzero lower-case 16-hex sessions,
lower-case 64-hex ZIP SHA-256 and IEEE/zlib CRC32 of raw block bytes:

```text
QDDDRV/1 <id> INFO
QDDDRV/1 <id> INFO <session> <bytes> <sha256> ZIP
QDDDRV/1 <id> READ <session> <offset> <length1..1024>
QDDDRV/1 <id> DATA <session> <offset> <length> <crc8> <hex2*length>
QDDDRV/1 <id> CANCEL <session>
QDDDRV/1 <id> OK
QDDDRV/1 <id> ERR <CODE>
```

Lines are capped at 2304 bytes; overflow/NUL lines discard through LF. Logs,
malformed replies and old IDs cannot advance the file. Each block allows three
attempts with new IDs at the same offset. `STALE_SESSION`/`IO_ERROR` permits only
one fresh INFO during the entire transfer, and continuation requires exactly the
original size/SHA/ZIP type; version changes abort. Per-request wait is four
seconds, total wait three minutes. These prepare-only timers are separate from
the unchanged HID ACK/watchdog limits. The ESP independently gates active
control and manages its 60-second idle session TTL. CANCEL is best-effort session
cleanup; an unacknowledged INFO has no known session to cancel.

Developers need an x64 MinGW-w64 GCC toolchain and Node for the build script.
The script uses `gcc` on PATH, or the explicit `QDD_USB_CC` compiler path:

```powershell
$env:QDD_USB_CC = 'D:/Espressif/host/w64devkit/bin/gcc.exe' # Example local toolchain
node apps/android-mcp-rust/tools/usb-driver/build.mjs
```

Outputs go to `apps/android-mcp-rust/build/usb-driver/v52/`. The manifest binds
source inputs, compiler/flags, original EXE and gzip SHA-256, and an allowlist of
system PE imports. The build runs all three portable regression programs and
the real native no-device self-test, which exercises BCrypt hash
allocation, repeated cleanup, atomic save and no-overwrite file fixtures.
Portable `test-protocol.c`, `test-transfer.c` and `test-hardware.c` exercise the
production parser, read/retry engine and exact hardware-ID filter with local
fixtures. Host tests and successful compilation do not establish real USB
throughput, physical no-reset behavior or complete product acceptance.
