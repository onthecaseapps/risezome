# Sidecar IPC Protocol

Wire-level protocol between the Node daemon and each per-OS native audio sidecar binary.

## Goals

- **Cross-platform identity.** The Node daemon code is OS-agnostic; each per-OS sidecar (Linux PipeWire, macOS ScreenCaptureKit, Windows WASAPI) is a separate binary that speaks the same wire protocol.
- **No bot in the meeting.** Audio is captured locally by the sidecar; the daemon never joins the meeting platform.
- **Integrity and authenticity at launch.** The daemon refuses to spawn a sidecar whose SHA-256 doesn't match an embedded manifest, and refuses to trust a sidecar that can't echo a per-launch nonce within 500 ms.

## Process model

The daemon spawns one sidecar process per active capture session via `child_process.spawn`. The sidecar inherits no environment beyond what the daemon explicitly passes.

| FD     | Direction        | Format                  |
| ------ | ---------------- | ----------------------- |
| stdin  | daemon → sidecar | NDJSON commands         |
| stdout | sidecar → daemon | binary framed PCM       |
| stderr | sidecar → daemon | NDJSON control messages |

stderr being used for control messages — rather than a side channel — keeps the protocol cheap to implement in every sidecar language (Swift, C++/WinRT, Rust) without requiring extra pipes or sockets.

## stdout: binary framed PCM

Each audio frame is encoded as:

```
+-----------------+----------------------------------+-----------------+---------------------+
| 1 byte: role    | (role-specific extra fields)     | 4 bytes: length | N bytes: PCM payload|
| tag             |                                  | (big-endian u32)| (Int16LE)           |
+-----------------+----------------------------------+-----------------+---------------------+
```

Role tags:

| Tag    | Meaning            | Extra fields                                            |
| ------ | ------------------ | ------------------------------------------------------- |
| `0x00` | local-system       | none                                                    |
| `0x01` | local-mic          | none                                                    |
| `0x02` | remote-participant | 2 bytes: participant id length (u16 BE) + N bytes utf-8 |
| `0x03` | remote-mixed       | none                                                    |

Payload constraints:

- PCM sample rate is **16 000 Hz mono Int16LE**.
- Each frame is **20 ms** = 320 samples = 640 bytes.
- Maximum payload length per frame: 1 MiB (sanity limit; well above any realistic frame).
- Frames are pushed sequentially. The daemon assigns a monotonic `index` from a frame counter; the sidecar does not include it on the wire.

## stderr: NDJSON control messages

One JSON object per line. Recognised types:

```json
{"type": "hello",            "sidecarVersion": "0.1.0", "nonceEcho": "<hex-32>"}
{"type": "started",          "device": "alsa-output.monitor", "sampleRate": 16000}
{"type": "device-changed",   "device": "<new device>"}
{"type": "permission-denied","reason": "<human readable>"}
{"type": "error",            "code": "<code>", "message": "<message>"}
{"type": "stopped",          "reason": "<optional>"}
```

Non-JSON stderr lines (panic messages, debug logs) are tolerated and forwarded to the daemon's log sink — they are not treated as protocol errors unless the line starts with `{`.

## stdin: NDJSON commands

```json
{"type": "nonce", "nonce": "<hex-32>"}
{"type": "stop"}
```

## Launch handshake

1. Daemon resolves the sidecar path to an **absolute path inside the install directory**. Relative paths and `$PATH` lookups are rejected at this layer.
2. Daemon computes the binary's SHA-256 and compares against an **embedded manifest**. Mismatch → `SidecarIntegrityError`; the daemon refuses to spawn.
3. Daemon spawns the binary, writes `{"type":"nonce","nonce":"<hex32>"}` to its stdin.
4. Sidecar must respond on stderr with `{"type":"hello", ..., "nonceEcho":"<same hex32>"}` within **500 ms**. Failure → daemon kills the process and raises `SidecarHandshakeError`.

Together these checks close two real attack paths: (a) tampered binary swapped after install (the SHA mismatch fails closed); and (b) another process opening the sidecar's stdout fd between spawn and first read (the nonce echo is observable only after the spawn handshake completes, which would-be attackers cannot influence).

## Backpressure

If the daemon falls behind processing frames (e.g., the transcription engine is slow), the runner drops the **oldest** queued frames after a configurable in-flight cap (default 200). The HUD prefers freshness over completeness during a live meeting.

## Error model

Typed errors with stable codes (`code` field on every `RisezomeError` subclass):

- `sidecar-launch` — process couldn't be spawned (binary missing, not executable).
- `sidecar-integrity` — SHA-256 mismatch against the embedded manifest.
- `sidecar-handshake` — nonce echo missing, late, or wrong.
- `sidecar-protocol` — malformed frame, unknown role tag, payload not a multiple of 2.
- `sidecar-exit` — non-zero exit code; carries `exitCode` and `stderrTail`.
- `permission-denied` — emitted on top of any `permission-denied` control message.

Internal diagnostics stay in local logs; the WebSocket boundary (U5) carries only `{code, userMessage}` per the plan's security policy.
