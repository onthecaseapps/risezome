# Risezome macOS audio sidecar

A small Swift program that captures 16 kHz mono Int16LE PCM from a local
CoreAudio input device and streams it to the bot-worker (or daemon) over the U3
IPC contract. It is the macOS counterpart to [`../linux`](../linux) and speaks
the **identical wire protocol** — only the audio backend differs.

The consumer spawns one instance per audio role:

- `--role=system` → captures a **loopback input device** (BlackHole). macOS has
  no built-in system-audio monitor like Linux's PulseAudio `.monitor` source, so
  a loopback device is required (see Setup).
- `--role=mic` → captures the **default input device** (microphone).

Pass `--device="<name substring>"` to capture a specific input device by name
(case-insensitive match).

## Setup

### 1. Build tools

```
xcode-select --install   # provides swiftc, if not already present
```

### 2. BlackHole (only needed for `--role=system`)

```
brew install blackhole-2ch
```

You'll need to restart your Mac:
```
installer: The install requires restarting now.
```

Then route system audio into it so the sidecar can capture it. Easiest is a
**Multi-Output Device** so you still hear audio while it's also sent to BlackHole:

1. Open **Audio MIDI Setup** (`/Applications/Utilities`).
2. **+ → Create Multi-Output Device**; check **both** your speakers/headphones
   and **BlackHole 2ch**.
3. Set that Multi-Output Device as the system output (System Settings → Sound →
   Output), or as the meeting app's output.

The sidecar auto-selects the first input device whose name contains `BlackHole`
for the system role; override with `--device` if you use a differently-named
loopback (e.g. `--device="BlackHole 16ch"`).

### 3. Build

```
make check-deps
make
```

Output: `build/risezome-sidecar-macos`.

### 4. Microphone / input permission

Capturing any input device (including BlackHole) requires the macOS microphone
TCC permission. Because the sidecar is spawned by the bot-worker, the permission
attaches to the **parent process**, not the sidecar:

- Run the bot-worker from a Terminal and grant **Terminal** (or your IDE/`node`)
  access under **System Settings → Privacy & Security → Microphone**.
- The first capture attempt triggers the prompt; if it doesn't appear, add the
  parent app manually in that pane and restart it.

If access is denied the sidecar emits `{"type":"permission-denied", ...}` and
exits, which the runner surfaces as a permission error on the debug page.

## Pointing the debug page at it

The bot-worker's local-debug handler resolves the sidecar by platform and falls
back to the `RISEZOME_SIDECAR_PATH` env var. On macOS it defaults to
`sidecars/macos/build/risezome-sidecar-macos`. To force a specific binary:

```
export RISEZOME_SIDECAR_PATH="$(pwd)/sidecars/macos/build/risezome-sidecar-macos"
```

The handler hashes the binary on the fly, so no manifest step is needed for the
debug page. (The standalone daemon's `serve` path verifies against a manifest —
use `scripts/compute-sha256.sh` and `RISEZOME_SIDECAR_SHA` there.)

## Wire protocol

See [`apps/daemon/src/audio/ipc/README.md`](../../apps/daemon/src/audio/ipc/README.md)
for the framed PCM + NDJSON control protocol spec.

This implementation produces:

- **`{"type":"hello", "sidecarVersion": "0.1.0-macos", "nonceEcho":"<hex>"}`** as
  the first stderr line after reading the launch nonce.
- **`{"type":"started", "device":"<name>", "sampleRate":16000}`** once capture opens.
- **`{"type":"permission-denied", "reason":"..."}`** if input access is denied.
- **`{"type":"error", "code":"...", "message":"..."}`** on a setup/runtime failure
  (e.g. `no-loopback` when no BlackHole device is found for the system role).
- **`{"type":"stopped"}`** on clean shutdown (SIGTERM / SIGINT, or stdout closed).

Audio frames on stdout are `[role tag u8][len u32 BE][PCM bytes]`, one per 20 ms
(320 samples / 640 bytes), 16 kHz mono Int16LE — byte-identical to the Linux
sidecar.

## Testing

Follow **[TESTING.md](./TESTING.md)** — a step-by-step guide that builds the
binary, proves it captures mic and system (BlackHole) audio standalone, and then
verifies it end-to-end through the Live-mic debug page, with a troubleshooting
table for the common macOS permission/loopback issues.

## Constraints

- One capture device per process. The `--role` selects the wire tag; if both
  `system` and `mic` are needed, the consumer spawns two sidecar processes.
- Sample-rate / channel conversion to 16 kHz mono is done with `AVAudioConverter`;
  the device's native format (typically 48 kHz float) is converted per tap buffer.
- The capture tap writes framed PCM directly to stdout. SIGTERM/SIGINT (or a
  closed stdout) stops the engine on the next boundary and emits `stopped`.
