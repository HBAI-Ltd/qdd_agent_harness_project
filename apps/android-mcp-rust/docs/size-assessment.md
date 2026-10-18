# Size assessment

[简体中文](size-assessment.zh_CN.md)

Measured on 2026-10-18 for Windows x64. The proposed architecture is ESP-hosted
download delivery followed by execution on the PC. The ESP does not execute the
Windows program. Exact values, hashes and validation identities are retained in
[size-assessment.json](size-assessment.json).

## Actual measurements

| Artifact | Bytes | MiB |
| --- | ---: | ---: |
| Current Node desktop EXE | 95,678,464 | 91.246 |
| Current Node EXE ZIP | 36,142,076 | 34.468 |
| Rust dependency/codec probe, before creating the package | 1,027,584 | 0.980 |
| Complete Rust release EXE | 1,863,168 | 1.777 |
| Complete Rust release ZIP | 903,569 | 0.862 |

The complete native EXE is **98.05% smaller** than
the measured Node EXE. The early dependency probe was a lower bound, not a
product-size claim. The final result includes all 22 frozen tool schemas,
HTTP/SSE and stdio MCP, WebSocket remote control, TCP/USB HID, JPEG/PNG target
preview, desktop settings/discovery and cancellable native HTTPS.

Release build: `rust-6cd85079fe3bd5e6`.

EXE SHA-256: `9e0f2828471dbf1a3ca376cb8d6898c6ce6238cabe8fe67afa48a48ce4d44c66`.

ZIP SHA-256: `d99a2559cade6de351f91262fd4e3246c67d2fb2aad6f0791d519e8462ae6fc7`.

PE import inspection found Windows system DLLs and no separately distributed
Node, Rust, VC runtime, OpenSSL or browser DLL. The EXE also passed the empty-PATH
and empty Chinese/space-containing directory acceptance scenario.

## ESP capacity budget

The v39 device table read at 08:56 uses two 3,080,192-byte OTA slots and a
2,097,152-byte assets partition. Its application is 1,666,016 bytes, including
the phone APK; the active slot therefore has 1,414,176 bytes of growth capacity.
These values come from the actual device's table and app write record, rather
than the repository's larger default factory partition.

| Storage choice | Capacity | Payload | Remaining |
| --- | ---: | ---: | ---: |
| Raw EXE in current application slot | 1,414,176 | 1,863,168 | Does not fit |
| Raw EXE in assets partition | 2,097,152 | 1,863,168 | 233,984 bytes (228.5 KiB) |
| ZIP embedded in current application | 1,414,176 | 903,569 | 510,607 bytes (0.487 MiB) |

The raw-EXE route supports download then double-click, provided the assets
partition's existing content is first identified and an ESP download endpoint
is implemented. The ZIP route fits the current application headroom and avoids
a partition change, but users must extract it on the PC. Both budgets still
need space for download metadata and any new firmware code. The measured
assets capacity is not a finding that its existing data is empty.

An ESP file server can read Flash in bounded pieces instead of copying the
whole program into SRAM. ESP-IDF provides [partition reads](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/storage/partition.html)
and [HTTP chunk sending](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/protocols/esp_http_server.html).
The current firmware already embeds and serves the much smaller phone APK.
The actual multi-MiB PC download path has not been implemented or measured.

## Validation and limits

- Rust: 58 tests passed, including real loopback TLS handshake/body cancellation.
- Packaged EXE: 17 frozen acceptance scenarios passed using the official MCP SDK.
- TypeScript typecheck/build, Rust all-target checking and formatting passed.
- A fragmented HTTP request regression failed with the old Winsock mode and
  passed after explicitly restoring blocking mode on accepted worker sockets,
  matching [Microsoft's accepted-socket behavior](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-accept).
- No real phone input, ESP flash, or ESP storage/download implementation occurred.

The native implementation is ready for a separate real-device acceptance step.
Live BLE timing, physical pointer accuracy and ESP download/radio concurrency
remain unverified. TLS tests use public test-only key material; their Windows
fixture behavior is documented in [the fixture notes](../tests/fixtures/README.md).
