# bot-worker/src/debug

Debug-only code path. Powers the `/debug/live-mic` page in the portal
so prompt + filter iteration can happen against a local microphone
(via the Linux PulseAudio sidecar) instead of paying for a Recall.ai
bot per test.

## Provenance

The following files are **copied** from `apps/daemon/src/`:

| File | Origin |
| --- | --- |
| `sidecar-runner.ts` | `apps/daemon/src/audio/ipc/sidecar-runner.ts` |
| `sidecar-protocol.ts` | `apps/daemon/src/audio/ipc/sidecar-protocol.ts` |
| `errors.ts` | `apps/daemon/src/audio/ipc/errors.ts` |
| `manifest.ts` | `apps/daemon/src/audio/ipc/manifest.ts` |
| `deepgram.ts` | `apps/daemon/src/transcribe/deepgram.ts` |

These are byte-for-byte copies at copy time. Drift between the two
locations is acceptable for now — the daemon's path is the production
desktop UX, the bot-worker's path is debug-only.

## Refactor TODO

If a third consumer of the sidecar/Deepgram code appears, extract into
a shared workspace package (`packages/sidecar-runner`,
`packages/deepgram-client`) and have both daemon + bot-worker depend
on it instead. The packages are 5 self-contained files (~700 LoC
total) — small refactor.

## Linux only

The Linux sidecar binary at `sidecars/linux/build/risezome-sidecar-linux`
is the only one wired here. macOS sidecar has a different protocol /
calling convention — debug-page support for macOS would be a follow-up.

## Env vars

- `DEEPGRAM_API_KEY` — required for the debug pipeline.
- `RISEZOME_SIDECAR_PATH` — optional, defaults to
  `sidecars/linux/build/risezome-sidecar-linux` relative to the repo root.
