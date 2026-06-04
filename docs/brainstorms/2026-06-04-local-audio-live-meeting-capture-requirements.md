---
topic: Local-audio live meeting capture (dev)
status: requirements
date: 2026-06-04
type: feature (dev tooling)
---

# Local-audio live meeting capture (dev)

## Problem Frame

Capturing meeting data today requires launching a **Recall.ai** bot, which costs money per meeting. That makes dogfooding the live pipeline and collecting real capture data expensive — every test meeting is a paid Recall session. The sidecar → Deepgram → bot-worker pipeline already works locally (proven by the local-mic debug page, `apps/portal/app/(authed)/debug/live-mic/` + `apps/bot-worker/src/debug/local-debug-ws.ts`), but it streams to a *debug* surface and doesn't persist as a real meeting.

This feature lets a developer capture a **real meeting from local microphone audio** instead of a Recall bot — same pipeline, same persistence, same live page and Captures/Review — so dogfooding and data capture are free. The **only** difference from a production meeting is where the audio comes from.

## Who It's For

- **A1 — The developer dogfooding / capturing data** (today: Nathan). Runs the app locally against the hosted (or local) Supabase, wants to record a meeting from their mic, watch the pipeline surface cards + syntheses live, and review the result as a normal capture — without launching or paying for a Recall bot.

Not for end users. This is dev tooling.

## Requirements

- **R1.** The **dev console** exposes a **"Start local meeting"** action (a dev-only surface; not in the product UI).
- **R2.** Starting creates a **real, ad-hoc `meetings` row** in the current dev user's org, with **no calendar event**, marked/distinguishable as locally-captured.
- **R3.** Starting **opens that meeting's live page** and points the **local sidecar** (mic → Deepgram) at the meeting.
- **R4.** Local audio drives the **same retrieval/synthesis pipeline as a Recall meeting**: cards, syntheses, and transcript **persist to that meeting** and **broadcast to the live page over Realtime**. The live page is **unchanged** — it's source-agnostic (subscribes to Realtime), so nothing on the page "knows" the audio is local.
- **R5.** The live page shows cards + streaming syntheses **in real time, identical to a Recall meeting**.
- **R6.** A **"Stop"** action ends capture: stops the sidecar, marks the meeting **`completed`**, and **fires the normal post-meeting processing** (recap generation, etc.) — the same lifecycle a Recall meeting gets at end.
- **R7.** The completed local meeting appears in **Captures and Review with full fidelity** — transcript, cards, syntheses, recap — exactly like any meeting.
- **R8.** **One local meeting at a time** (one mic / one sidecar). Starting another while one is active is prevented (or stops the prior) with a clear message.
- **R9.** Start **reuses the dev console's existing sidecar readiness/build check**; if the sidecar binary isn't built/available, it builds it or errors clearly — never silently fails to capture.
- **R10.** **Recall behavior is unchanged.** A local meeting never launches a Recall bot; production Recall meetings are entirely unaffected.

## Acceptance Examples

- **AE1 (start → live).** Dev clicks **Start local meeting** → a meeting row is created in the dev org, the live page opens, the sidecar starts. Speaking into the mic surfaces cards and streaming syntheses on the live page within the normal pipeline latency. *(R1–R5)*
- **AE2 (stop → capture).** Dev clicks **Stop** → the sidecar stops, the meeting is marked `completed`, the recap generates → the meeting appears in **Captures** and opens in **Review** with transcript, cards, syntheses, and recap. *(R6, R7)*
- **AE3 (single-mic guard).** A local meeting is active; dev clicks **Start local meeting** again → blocked with "a local meeting is already running" (or it stops the prior first). *(R8)*
- **AE4 (no sidecar).** The sidecar binary isn't built → Start builds it (or surfaces a clear error) before capture begins, rather than opening a dead live page. *(R9)*
- **AE5 (no Recall, no bleed).** No Recall bot is ever created for a local meeting; a concurrently-scheduled real Recall meeting behaves exactly as today. *(R10)*

## Scope Boundaries

**In scope**
- Dev console **Start / Stop local meeting** controls.
- Ad-hoc meeting creation (dev org, no calendar), marked as locally-captured.
- Local audio → the **production persist + broadcast pipeline** (the same path a Recall meeting uses, not the debug page's WS-streaming path).
- Full meeting lifecycle on stop: `completed` + post-meeting recap → Captures/Review fidelity.
- Single-mic guard + sidecar readiness reuse.

**Deferred for later**
- A persistent **"local audio mode" toggle** — the explicit Start/Stop action covers the need; a master switch can come later if it earns its keep.
- **System-audio** capture (vs. mic only) for recording real calls played through the machine.
- Multiple concurrent local meetings.

**Outside this product's identity**
- A **user-facing / shipping** feature. This is dev tooling; it stays on the dev console.
- Changing the **production Recall** launch/ingest path.
- **Replacing the local-mic debug page** — that surface stays for per-utterance pipeline tracing (the new Pipeline Trace Debug page); this feature is the *capture-a-real-meeting* counterpart, not a merge.
- **Multi-participant / multi-mic** capture or speaker diarization beyond what the single mic + Deepgram already provide.

## Success Criteria

- A developer can capture a **full meeting from local mic** — watch cards/syntheses live, then review it in Captures with a recap — **without launching or paying for a Recall bot**.
- The captured meeting is **indistinguishable in Captures/Review** from a Recall-sourced one (same transcript/cards/syntheses/recap), apart from being flagged local.
- **Zero change** to production Recall behavior.

## Dependencies / Assumptions

- The **bot-worker runs locally** and the **audio sidecar is built** for the OS (the dev console already manages this; see `scripts/dev-console/` + `apps/bot-worker/src/debug/sidecar-runner.ts`).
- **Deepgram** is configured (already used by the local-mic debug path).
- The **crypto/KMS env** is configured so the meeting's syntheses/transcript/recap encrypt on write and decrypt on read (set up 2026-06-04; hosted DB → AWS KMS, local DB → dev keyring — see the crypto-backend-per-environment note).
- Persisting to a real meeting reuses the production sink (the path that writes the `meetings`/`cards`/`syntheses`/`meeting_events` rows and broadcasts on the `meeting:<org>:<meeting>` Realtime channel), **not** the debug page's `sink-ws`. *(Mechanism note for planning; the exact wiring is a `/ce-plan` decision.)*

## Related Prior Art

- **Local-mic debug page** — `apps/portal/app/(authed)/debug/live-mic/`, `apps/bot-worker/src/debug/local-debug-ws.ts`: proves sidecar → Deepgram → `runPipeline`; streams to a debug surface (does not persist a meeting). This feature reuses the audio source but swaps the sink to the production persist+broadcast path.
- **Live meeting page** — `apps/portal/app/(authed)/meetings/[meetingId]/live`: source-agnostic Realtime consumer; unchanged by this feature.
- **Post-meeting recap** — `apps/portal/src/inngest/functions/generate-meeting-recap.ts`: the lifecycle a local meeting should also trigger on stop.
- **Consolidated pipeline** — `apps/bot-worker/src/pipeline/core.ts` (`runPipeline`) + sinks: the single pipeline both Recall and local audio drive.
