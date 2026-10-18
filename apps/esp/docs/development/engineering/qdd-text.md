<p align="right"><a href="qdd-text.zh_CN.md">简体中文</a> · <strong>English</strong></p>

# Unicode text channel

The optional phone input method commits a bounded UTF-8 string into the active
Android editor through the controller's encrypted, bonded BLE link. ASCII retains
the existing HID keyboard path. Enabling/selecting the input method and focusing
an editable field are explicit phone actions. The channel does not read editor
content, use clipboard/accessibility, or enable ADB input.

## Controller protocol

The USB/LAN line limit remains 128 bytes. Request IDs are positive signed-32-bit
decimals. Transfer IDs are nonzero unsigned-64-bit values encoded as exactly
16 hex digits; they strictly increase within the same editor epoch.

```text
QDDTXT/1 <requestId> BEGIN <transferId> <editorEpoch> <utf8Bytes>
QDDTXT/1 <requestId> DATA <transferId> <offset> <hexBytes>
QDDTXT/1 <requestId> COMMIT <transferId>
QDDTXT/1 <requestId> STATUS <transferId or 0>
QDDTXT/1 <requestId> CANCEL <transferId>
```

`BEGIN` reserves one 1–512-byte transfer for the nonzero current editor epoch.
`DATA` accepts 1–24 bytes at the next offset; an identical previously received
slice is harmless, while gaps and overwrites fail. `COMMIT` requires complete,
strict UTF-8 without NUL and queues the transfer without waiting for the phone.
Repeating COMMIT returns the existing state and never sends another commit.

All modifying commands require the current USB/LAN owner, a fresh PING lease,
explicit ARM, encrypted/bonded HID readiness with a verified 16-byte link key, and an unlocked
controller outside settings. Text does not implicitly ARM. `STATUS` is read-only
and does not claim ownership. The existing 1500 ms controller watchdog and
1200 ms host acknowledgment deadline are unchanged.

A successful line reply contains `id`, `status`, `editorEpoch`, `ready`,
`received` and `bytes`. States are `idle`, `receiving`, `queued`, `sending`,
`awaiting_ack`, `accepted`, `rejected`, `uncertain` and `cancelled`.
`STATUS 0` (also encoded as 16 zero hex digits by the Rust client) reports
the current editor epoch and latest transfer ID; a specific ID
reports that transfer's original epoch. Older superseded IDs fail with
`STALE_TRANSFER`. Pending queued/sending/awaiting-ACK states retain the complete
byte count. Terminal states erase text and report zero byte counts.

PAUSE, stop, owner loss, disconnect or focus/epoch change clears pending text.
Receiving text loses focus as rejected; already queued or possibly delivered
text becomes uncertain. A matching late phone ACK may resolve an uncertain
commit, without replay. Accepted results survive later focus changes. The phone
result window is 10 seconds from queueing; no text or COMMIT is retried after a
possible submission. `accepted` means InputConnection accepted the commit API,
and still needs a fresh real phone image to verify the target UI outcome.

## BLE wire

The service is appended after existing HID/battery/device-information services
so their handles remain ordered. The standard Service Changed indication updates
bonded clients; existing bonds are retained and no hidden cache-refresh API is
used.

- Service: `9bded201-39ba-4a19-8ff7-25c9d00a0001`.
- Controller indication: `9bded201-39ba-4a19-8ff7-25c9d00a0002`.
- Phone encrypted write: `9bded201-39ba-4a19-8ff7-25c9d00a0003`.

Pairing uses Just Works inside the explicitly opened pairing window, without a
numeric PIN. Encryption, bonding and a 16-byte link key remain required. The
`authenticated` status reports the real MITM flag; it may be false for a valid
Just Works connection. Existing bonds are retained. New pairing and existing-bond
recovery must still be checked on the actual phone; host success is not device acceptance.

Each frame starts with version byte 1 and the type byte below; integers are
little-endian. BEGIN/DATA need only ATT confirmation. The phone business ACK is
sent after COMMIT and carries the original transfer epoch even if commitText
synchronously changes focus.

| Type | Direction | Remaining fields | Total bytes |
| --- | --- | --- | ---: |
| 01 BEGIN | Controller → phone | id64, epoch32, length16 | 16 |
| 02 DATA | Controller → phone | id64, offset16, bytes | 12 + bytes |
| 03 COMMIT | Controller → phone | id64, epoch32 | 14 |
| 04 CANCEL | Controller → phone | id64 | 10 |
| 81 READY | Phone → controller | epoch32 | 6 |
| 82 ACK | Phone → controller | id64, status8, epoch32 | 15 |
| 83 NOT_READY | Phone → controller | epoch32 | 6 |

ACK status 0 means accepted, 1 rejected, 2 uncertain. READY is valid only for the
selected input method with a current editor and an encrypted bonded subscription.
At MTU 23, DATA carries 8 bytes, so a maximum transfer uses 66 indications.
A single public NimBLE host event and 64-byte staging buffer coordinate with
Service Changed's ATT slot; only one mbuf is allocated at a time. Sent events do
not count as confirmation. Tokens reject stale confirmations, and an unsent
staging frame is cancelled on gate/focus loss. The sender rechecks the lease and
atomic stop/settings latch immediately before submission.

## Validation boundary

`test_qdd_text.c` covers parsing, UTF-8, offsets, monotone IDs, MTU fragmentation,
terminal erasure, duplicate commits, focus epochs and cancellation. The static
gate also runs `test_qdd_text_integration.py`, which executes extracted production
main and BLE sender functions with deterministic hardware boundaries. It covers
owner/ARM/security gates, a busy Service Changed slot, one outstanding frame,
queued cancellation, deadlines and original-epoch terminal results.

Build and host success do not verify OEM input-method/BLE-HID coexistence,
existing-bond service rediscovery, actual Unicode insertion, or screenshot
feedback. These require authorized real-device tests. The separate driver
resource format is documented in [Driver download resources](download-assets.md).
