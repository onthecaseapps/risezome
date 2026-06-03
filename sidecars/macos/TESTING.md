# Testing the macOS sidecar

A progressive checklist: build it, prove the binary captures audio on its own,
then prove it end-to-end through the Live-mic debug page. Do the levels in
order — each one isolates a different failure surface, so if Level 3 misbehaves
you already know Levels 0–2 are good.

All commands run from `sidecars/macos/` unless noted.

---

## Level 0 — Build

```bash
make check-deps        # confirms swiftc; warns if BlackHole is missing
make                   # → build/risezome-sidecar-macos
./build/risezome-sidecar-macos --help
```

✅ Expect: the binary exists and `--help` prints usage.
❌ `swiftc: command not found` → `xcode-select --install`.

---

## Level 1 — Standalone mic capture (no bot-worker)

This proves the sidecar reads the nonce, handshakes, and streams real PCM —
nothing else involved.

```bash
echo '{"type":"nonce","nonce":"deadbeef"}' \
  | ./build/risezome-sidecar-macos --role=mic \
  > /tmp/cap.pcm 2> /tmp/cap.log
```

Speak into the mic for ~5 seconds, then `Ctrl-C`.

The **first time** you run it, macOS should prompt for microphone access (or you
may need to add **Terminal** under System Settings → Privacy & Security →
Microphone, then re-run — see Troubleshooting).

Check the control log:

```bash
cat /tmp/cap.log
```

✅ Expect, in order:
```
{"type":"hello","sidecarVersion":"0.1.0-macos","nonceEcho":"deadbeef"}
{"type":"started","device":"<your mic>","sampleRate":16000}
{"type":"stopped"}
```

Check the audio is real (strip the 5-byte frame headers, then play):

```bash
python3 - <<'PY'
import struct
data = open('/tmp/cap.pcm','rb').read()
out = bytearray(); i = 0
while i + 5 <= len(data):
    ln = struct.unpack('>I', data[i+1:i+5])[0]; i += 5
    out += data[i:i+ln]; i += ln
open('/tmp/cap.raw','wb').write(out)
print('decoded', len(out), 'PCM bytes (', len(out)//2, 'samples,', round(len(out)/2/16000,1), 's )')
PY

ffmpeg -y -f s16le -ar 16000 -ac 1 -i /tmp/cap.raw /tmp/cap.wav
afplay /tmp/cap.wav     # you should hear yourself
```

✅ Expect: `/tmp/cap.pcm` non-empty, the decode reports ~5 s of samples, and
`afplay` plays back your voice clearly (not chipmunk/slow — that would mean the
resample is wrong).

---

## Level 2 — Standalone system-audio capture (BlackHole)

This proves `--role=system` captures system output via the loopback device.

**One-time routing setup** (so you still hear audio while it's captured):

1. `brew install blackhole-2ch` if you haven't.
2. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device** → check
   **both** your speakers/headphones **and BlackHole 2ch**.
3. System Settings → Sound → Output → select that **Multi-Output Device**.

Now capture while something plays:

```bash
# start some audio playing first (music, a YouTube video, etc.), then:
echo '{"type":"nonce","nonce":"deadbeef"}' \
  | ./build/risezome-sidecar-macos --role=system \
  > /tmp/sys.pcm 2> /tmp/sys.log
```

Let it run ~5 s, `Ctrl-C`, then decode + play as in Level 1 (swap `cap`→`sys`).

✅ Expect: `started` names the **BlackHole** device, and the playback is the
audio that was playing (not silence).
❌ `{"type":"error","code":"no-loopback",...}` → BlackHole isn't installed or
isn't an input device; finish the setup above. Use
`--device="BlackHole"` (or your loopback's exact name) to be explicit.

---

## Level 3 — End-to-end through the Live-mic debug page

This is the real target: the portal debug page → bot-worker `/local-debug` →
**the bot-worker spawns this sidecar** → Deepgram → cards.

Start the local processes (from the repo root — see
[`docs/runbooks/local-dev-processes.md`](../../docs/runbooks/local-dev-processes.md)):

```bash
pnpm --filter @risezome/portal dev            # :3000
pnpm --filter @risezome/bot-worker dev        # :8787  (needs apps/bot-worker/.env)
```

The bot-worker auto-resolves the macOS binary (its `defaultSidecarPath()` picks
`sidecars/macos/build/risezome-sidecar-macos` on darwin). To force a specific
build, export before starting it:

```bash
export RISEZOME_SIDECAR_PATH="$(pwd)/sidecars/macos/build/risezome-sidecar-macos"
```

Then:

1. Open `http://localhost:3000`, sign in, and go to **Live-mic debug** (under DEV
   in the sidebar).
2. Start the capture. The bot-worker spawns the sidecar (`--role=system`).
3. Have audio playing through the Multi-Output Device (or talk, if you switch the
   role to mic for the test).

✅ Expect: live utterances appear as Deepgram transcribes the captured audio,
and retrieval cards / synthesis populate the columns.

Watch the bot-worker logs — you should see:
```
local-debug.start ... sidecarPath=.../risezome-sidecar-macos
sidecar.control {"type":"hello",...}
sidecar.control {"type":"started",...}
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `{"type":"permission-denied",...}` or silent empty PCM | Microphone TCC not granted. The grant attaches to the **parent** process — add **Terminal** (Level 1/2) or **node**/your IDE (Level 3) under Privacy & Security → Microphone, then restart that process. |
| `{"type":"error","code":"no-loopback"}` | No BlackHole input found for `--role=system`. Install it and finish the Multi-Output routing, or pass `--device="<loopback name>"`. |
| `{"type":"error","code":"device-not-found"}` | `--device` substring matched no input device. List devices in Audio MIDI Setup and match the exact name. |
| PCM file non-empty but playback is **silence** | Audio isn't actually routed to the captured device. For system role, confirm output is the Multi-Output Device and something is playing. |
| Playback is too fast/slow or garbled | Sample-rate conversion problem — capture the build/compiler output and the `started` device's native rate and send it over; the `AVAudioConverter` setup likely needs a tweak. |
| Handshake never completes / runner times out | The sidecar must emit `hello` within 500 ms. If a permission prompt is blocking first-run, grant it once interactively (Level 1) so subsequent spawns are instant. |
| Level 3 shows no utterances but Levels 1–2 work | Not a sidecar problem — check `DEEPGRAM_API_KEY` and `BOT_WORKER_SECRET` in `apps/bot-worker/.env`, and the bot-worker logs for a Deepgram error. |

If a build error or a wrong-format capture appears, paste the `make` output (or
the `started` line + native device rate) and the failing level — those pinpoint
the fix fast.
