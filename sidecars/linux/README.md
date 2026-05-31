# Risezome Linux audio sidecar

A small C program that captures 16 kHz mono Int16LE PCM from a PulseAudio / PipeWire source and streams it to the daemon over the U3 IPC contract.

The daemon spawns one instance of this binary per audio role per active capture session:

- `--role=system` → captures the system output's `.monitor` source (system audio).
- `--role=mic` → captures the default input device (microphone).

PipeWire serves the PulseAudio protocol natively on modern Linux distros, so `libpulse` works against PipeWire transparently. PulseAudio-only systems also work without changes.

## Build

```
sudo apt install build-essential libpulse-dev pkg-config   # Debian / Ubuntu
make check-deps
make
```

Output: `build/risezome-sidecar-linux`.

The daemon verifies this binary's SHA-256 against its embedded manifest before spawning (per U3), so re-run the daemon's manifest-generation step after any rebuild.

## Wire protocol

See [`apps/daemon/src/audio/ipc/README.md`](../../apps/daemon/src/audio/ipc/README.md) for the framed PCM + NDJSON control protocol spec.

This implementation produces:

- **`{"type":"hello", "sidecarVersion": "0.1.0-linux", "nonceEcho":"<hex>"}`** as the first stderr line after reading the daemon's nonce.
- **`{"type":"started", "device":"default", "sampleRate":16000}`** when PulseAudio capture opens.
- **`{"type":"permission-denied", "reason":"..."}`** if PulseAudio rejects the connection (e.g., no `pulse` group membership).
- **`{"type":"error", "code":"...", "message":"..."}`** on a runtime read failure or stdin protocol error.
- **`{"type":"stopped"}`** on clean shutdown (SIGTERM / SIGINT received, or stdout closed).

## Choosing the source

When `--device` is not specified, the sidecar passes `NULL` to `pa_simple_new`, which selects the server's default source. For system-audio capture you typically want the active output's monitor — set `PULSE_SOURCE` to that name when invoking the sidecar:

```
PULSE_SOURCE="$(pactl get-default-sink).monitor" ./build/risezome-sidecar-linux --role=system
```

The daemon's launcher does this resolution before spawn; you only need it for manual smoke tests.

## Manual smoke test

In one terminal, run `paplay` against a known tone or your own playback. In another:

```bash
echo '{"type":"nonce","nonce":"deadbeef"}' \
  | PULSE_SOURCE="$(pactl get-default-sink).monitor" ./build/risezome-sidecar-linux --role=system \
  > /tmp/risezome-capture.pcm 2> /tmp/risezome-capture.log
```

After a few seconds, kill the sidecar (`Ctrl-C`). Verify:

- `/tmp/risezome-capture.log` contains `{"type":"hello", "sidecarVersion":"0.1.0-linux", "nonceEcho":"deadbeef"}` then `{"type":"started", ...}`.
- `/tmp/risezome-capture.pcm` is non-empty.
- Pipe the raw PCM through `sox` (after stripping our framing headers) or use `ffmpeg -f s16le -ar 16000 -ac 1 -i /tmp/risezome-capture-stripped.pcm` to verify audibility.

## Constraints

- One pa_simple stream per process. The `--role` selects the wire tag; if both `system` and `mic` are needed, the daemon spawns two sidecar processes (one per role).
- Capture is blocking on the audio thread; SIGTERM exits the loop on the next read boundary.
- Stdin is read once for the launch nonce. Subsequent stdin input is ignored — the daemon kills with SIGTERM for a clean shutdown.
