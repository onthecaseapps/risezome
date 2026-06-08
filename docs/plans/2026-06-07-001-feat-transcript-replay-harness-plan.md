---
date: 2026-06-07
status: active
type: feat
origin: docs/brainstorms/2026-06-07-transcript-replay-harness-requirements.md
---

# feat: Transcript Replay Harness (live-pipeline debug)

## Summary

Add a **transcript replay mode** to the existing local-mic debug page (`apps/portal/app/(authed)/debug/live-mic/`). Load a captured meeting's transcript + per-utterance timings (by meeting ID, or a pasted/uploaded file), replay the finalized utterances at faithful (long-gap-capped) cadence through the **real, current** bot-worker pipeline, then use the page's existing per-utterance trace inspector to see every gate/step + inputs/outputs — and copy a structured summary to paste into an LLM for analysis. Built as an **extension** of the existing harness, not a new system (see origin: docs/brainstorms/2026-06-07-transcript-replay-harness-requirements.md).

---

## Problem Frame

Live synthesis failures (motivating case: clear GitHub *skill* questions answered by RAG over the skill's own source instead of routing to `github_count`; redundant near-dup syntheses) are interaction failures across timing- and sequence-dependent gates (relevance gate, two-lane routing, cooldown, dedup/voiding, skill-vs-RAG routing). They can only be reproduced live (slow, non-deterministic) or via `corpus-eval` (single golden questions — no cadence, no context-combining, no per-gate view). There is no way to replay a real conversation through the pipeline and see *which* decision produced the wrong outcome.

The existing local-mic harness already runs the real pipeline and renders a rich per-utterance trace — it is missing only a non-audio input path (replay), a couple of trace fields, and an export. This plan fills exactly those gaps.

---

## Key Technical Decisions

**KTD1. Client-driven replay over the existing WebSocket.** The page owns playback (pause/restart/speed/progress) and sends timed finalized-utterance messages over the existing debug WS; the sidecar gains a `replay-utterance` inbound that feeds the *same* per-utterance pipeline path the live `engine.on('final')` handler uses. Rejected sidecar-driven scheduling (send whole transcript, sidecar times it) because it would need a separate control channel for pause/speed and duplicate playback state server-side. (Decision per origin synthesis.)

**KTD2. Run the real, current pipeline each replay — no recorded/mocked outputs.** Replays issue live relevance/router/skill/retrieval/synthesis calls so a *re-run after a code fix validates the fix*. LLM calls are temperature 0, so jitter is low; this is a debugging loop, not a deterministic golden test (that's `corpus-eval`'s job).

**KTD3. Extract the per-final pipeline trigger into a named handler; do not fork the live path.** The live `final` handler in `local-debug-ws.ts` is an inline closure capturing per-connection state (`recentFinals`, `consumedFinals`, `answeredSourceSets`, summarizer runtime, dedup state). Extract it into a single named handler that both the Deepgram-`final` path and the new `replay-utterance` path call, so replay exercises identical gate/voiding/merge logic and the live mic path is unchanged.

**KTD4. Faithful cadence with a long-idle-gap cap + speed multiplier.** Preserve real inter-utterance gaps (the sub-30s windows that drive cooldown/dedup/two-lane), clamp gaps to a max (default ~5s), and divide by a speed multiplier. A 16-min meeting replays in ~1–2 min without distorting the timing windows being debugged.

**KTD5. Decrypt the meeting-ID source server-side via a portal debug route.** `meeting_events.transcript_text_enc` is per-org KMS-encrypted; the browser can't decrypt. A debug API route reuses `transcriptWithText` (`apps/portal/app/_lib/transcript.ts`) to return ordered plaintext utterances (`utteranceId, text, speaker, startMs`) for the page to replay. The file source is parsed client-side (no decrypt). Replay therefore runs in the **viewer's org context** — the same corpus/connections the meeting used, which is what reproduces routing.

**KTD6. Scoped trace enrichment, not a trace-model rewrite.** The page already renders a gate-by-gate journey (outcome banner, latency waterfall, suppression-gate ribbon, stage ledger with per-stage output links). Audit the emitted `trace` events for the two fields the bug class needs — the **route decision (skill name vs RAG, with the reason)** and the **exact prior context** passed into each step — and add only those where missing.

---

## High-Level Technical Design

Replay reuses the entire live data path from the `final`-handler seam onward; only the *input* changes.

```
LIVE (today):   mic → engine.sendFrame → Deepgram → engine.on('final') ─┐
                                                                          ├─► handleFinalUtterance(u)
REPLAY (new):   page replay driver ── WS {replay-utterance} ────────────┘        │
                  (timed, gap-capped,                                              ▼
                   speed-scaled)                              rolling buffer + voiding/effective-window
                                                              + continuation merge → relevance gate →
                                                              two-lane routing → cooldown/dedup →
                                                              skill-router | RAG → retrieval → synthesis
                                                                              │
                                                              emits typed WS events (utterance, card,
                                                              skill-result, trace, synthesis-*, summary)
                                                                              ▼
                page panels (existing): transcript list · TracePanel (per-utterance journey) ·
                                        outputs panel · [NEW] Copy summary
```

Replay session lifecycle on the page: `idle → loading (fetch/parse transcript) → playing ⇄ paused → done`. A `replay-reset` is sent before a run to clear per-connection sidecar state so successive replays don't bleed context.

---

## Implementation Units

### U1. Extract the final-utterance handler + add replay inbound (sidecar)

- **Goal:** Make the per-final pipeline trigger callable from a non-audio source, and accept replayed utterances over the WS — without changing live-mic behavior.
- **Requirements:** R3 (real pipeline), R2 (feed finalized utterances into the same path); KTD1, KTD3.
- **Dependencies:** none.
- **Files:**
  - `apps/bot-worker/src/debug/local-debug-ws.ts` (modify — extract `handleFinalUtterance(utterance)` from the `engine.on('final')` closure; add inbound `replay-utterance` + `replay-reset` message handling)
  - `apps/bot-worker/test/debug/local-debug-ws.test.ts` (create or extend)
- **Approach:** Refactor the body of `engine.on('final', …)` into a named handler closing over the same per-connection state (`recentFinals`, `consumedFinals`, `answeredSourceSets`, `summarizerRuntime`, dedup state). The live handler becomes a one-line call. Add to the socket message switch: `replay-utterance` → construct the finalized-utterance shape (`utteranceId`, `text`, `speaker`, `startMs`) and invoke `handleFinalUtterance`; `replay-reset` → clear the per-connection rolling/dedup/consumed state. Replay utterances must NOT also go through Deepgram. Gate is unchanged (env-flag-protected debug route).
- **Execution note:** Characterization-first — pin the current live `final` path behavior (gate fire, voiding, continuation merge) with a test before extracting, so the refactor is provably behavior-preserving.
- **Patterns to follow:** the existing inbound message handling + `forwardUtterance` + `send(socket, …)` in `local-debug-ws.ts`; effective-window/voiding helpers in `apps/bot-worker/src/pipeline/answer-dedup.ts`.
- **Test scenarios:**
  - Replay path parity: feeding a `replay-utterance` runs the same handler as a Deepgram `final` (gate evaluated, rolling buffer appended, effective-window/voiding applied) — assert identical pipeline invocation for the same text.
  - `replay-reset` clears per-connection state: after reset, a repeated utterance is treated as first-seen (no stale `consumedFinals`/dedup carryover).
  - Empty/whitespace replayed text is ignored (mirrors the live `text.length === 0` guard).
  - Live mic path unchanged: a Deepgram `final` still triggers exactly one handler run (no double-trigger from the refactor).
- **Verification:** Live mic still works end-to-end; a replayed utterance produces the same WS event stream a spoken one would.

### U2. Transcript source: decrypt route + file parser

- **Goal:** Provide ordered utterances+timings from a past meeting (by ID) and from a pasted/uploaded file.
- **Requirements:** R1; KTD5.
- **Dependencies:** none.
- **Files:**
  - `apps/portal/app/api/debug/replay-transcript/route.ts` (create — `GET ?meetingId=…` → decrypted ordered utterances)
  - `apps/portal/app/(authed)/debug/live-mic/_replay-source.ts` (create — client file-parser + a shared `ReplayUtterance` type)
  - `apps/portal/test/debug/replay-transcript-route.test.ts` (create)
  - `apps/portal/test/debug/replay-source.test.ts` (create)
- **Approach:** The route authorizes (debug-gated, `requireAuthedUserWithOrg`), reads `meeting_events` `transcript.data` rows for the meeting via `transcriptWithText` (reusing the per-org KMS decrypt), and returns `{ utteranceId, text, speaker, startMs }[]` ordered by `startMs`. Degrade per existing patterns (EnvelopeCryptoError → 500 with a typed error, never leak). The file parser accepts a simple, documented format (e.g., JSONL of the same shape, or `[mm:ss] speaker: text` lines → derive `startMs`) and yields the same `ReplayUtterance[]`.
- **Patterns to follow:** `apps/portal/app/api/meetings/[meetingId]/events/route.ts` (debug-ish server read + decrypt + degrade); `apps/portal/app/_lib/transcript.ts` (`transcriptWithText`, payload `startMs`/`speaker`).
- **Test scenarios:**
  - Route returns ordered `ReplayUtterance[]` for a meeting with a multi-utterance transcript (decrypted, sorted by `startMs`).
  - Route is org-scoped: a meeting outside the caller's org is not returned.
  - Decrypt failure degrades to a typed error (no 200 with garbage, no plaintext leak).
  - File parser: a well-formed file → correct `ReplayUtterance[]` with derived `startMs`; a malformed line → skipped/`reported`, not a crash.
  - Empty input (no rows / empty file) → empty list, no throw.
- **Verification:** Both sources yield an identical `ReplayUtterance[]` shape the driver can consume.

### U3. Replay driver + controls (page)

- **Goal:** A replay mode on the live-mic page that loads a source, plays utterances at faithful-capped cadence with controls, reusing the existing inspection panels.
- **Requirements:** R2, R5, R7; KTD1, KTD4.
- **Dependencies:** U1 (sidecar `replay-utterance`/`replay-reset`), U2 (sources).
- **Files:**
  - `apps/portal/app/(authed)/debug/live-mic/_client.tsx` (modify — add a replay mode: source input (meeting ID / file), the playback driver, controls)
  - `apps/portal/app/(authed)/debug/live-mic/_replay-driver.ts` (create — pure cadence/scheduling logic)
  - `apps/portal/test/debug/replay-driver.test.ts` (create)
- **Approach:** A pure `computeSchedule(utterances, { maxGapMs, speed })` produces per-utterance delays: `delay = min(rawGap, maxGapMs) / speed`, first utterance at 0. The driver walks the schedule, sending `{ type: 'replay-utterance', … }` over the existing WS at each tick; supports pause (hold remaining timers), restart (send `replay-reset`, re-arm from 0), and exposes progress (`n/total`, elapsed). The page gains a mode switch (Mic ⇄ Replay), a source picker (meeting ID field / file upload), and transport controls + a speed/maxGap input. Replayed utterances flow into the *same* transcript/trace/outputs panels already rendered. Keep the cadence math out of the component (in `_replay-driver.ts`) so it is unit-testable.
- **Patterns to follow:** existing WS client + `send()` + state in `_client.tsx`; the existing transcript/`TracePanel`/outputs wiring (do not rebuild it).
- **Test scenarios:**
  - `computeSchedule` preserves short gaps exactly and caps long gaps to `maxGapMs` (e.g. a 4-min silence → `maxGapMs`).
  - Speed multiplier divides all delays (speed 2 → half the wall-clock); first utterance always at delay 0.
  - Ordering preserved; total scheduled count equals input count.
  - Pause then resume does not drop or duplicate utterances; restart re-emits from the first.
  - Edge: single-utterance transcript schedules one immediate send; empty transcript schedules nothing.
- **Verification:** Replaying a loaded meeting drives the existing per-utterance panels exactly as a live mic session would, at compressed-but-faithful cadence.

### U4. Trace enrichment — route decision + prior context

- **Goal:** Ensure each utterance's trace records the skill-vs-RAG route decision (with reason) and the exact prior context passed into each step, so the inspector explains *why* a question took the path it did.
- **Requirements:** R4; KTD6.
- **Dependencies:** none (can land in parallel with U1–U3).
- **Files:**
  - `apps/bot-worker/src/debug/local-debug-ws.ts` and/or `apps/bot-worker/src/pipeline/sink-ws.ts` (modify — emit route + context in the `trace` events)
  - `apps/portal/app/(authed)/debug/live-mic/_pipeline-model.ts` + `_trace-panel.tsx` (modify — index + render the new fields)
  - `apps/portal/test/debug/pipeline-model.test.ts` (create or extend)
- **Approach:** Audit the current `trace`/stage-ledger payload against R4's required fields. The route decision is made in `packages/engine/src/query-route/query-route.ts` + `router/heuristic.ts` (skill name or RAG, plus the classifier/heuristic reason); ensure that decision + reason reaches a trace stage. Ensure the **query and prior context** actually sent to retrieval/synthesis (the effective window after voiding + any continuation merge) is captured on the trace, since context-combining is the prime suspect. Add fields additively to the trace event type; index them in `indexTrace` (`_pipeline-model.ts`); render in the stage ledger / outputs.
- **Patterns to follow:** the existing `TraceEvent`/`UtteranceTrace` indexing in `_pipeline-model.ts`; the stage-ledger `outputsLink` → `_outputs-panel.tsx` pattern for showing per-stage I/O.
- **Test scenarios:**
  - `indexTrace` surfaces the route decision (skill name vs RAG) and reason for an utterance whose trace includes them.
  - The prior-context payload (effective window post-voiding) is associated with the correct utterance's trace.
  - Back-compat: a trace event WITHOUT the new fields still indexes without crashing (older/partial streams).
  - A skill-routed utterance and a RAG-routed utterance produce visibly different route fields in the indexed trace.
- **Verification:** Opening any replayed utterance shows which route it took, the reason, and the exact context fed to each step.

### U5. Copy summary export

- **Goal:** One click copies a structured, LLM-pasteable text dump of the whole replay — every utterance with its decisions, route, step I/O, and prior context.
- **Requirements:** R6.
- **Dependencies:** U4 (enriched trace), U3 (button lives in replay mode).
- **Files:**
  - `apps/portal/app/(authed)/debug/live-mic/_replay-summary.ts` (create — pure serializer over the indexed traces)
  - `apps/portal/app/(authed)/debug/live-mic/_client.tsx` (modify — "Copy summary" button → clipboard)
  - `apps/portal/test/debug/replay-summary.test.ts` (create)
- **Approach:** A pure `formatReplaySummary(utterances, tracesById)` → markdown-ish text: per utterance, the text, terminal outcome, gate decisions (relevance/lane/cooldown/dedup/voiding), route (skill vs RAG + reason), the prior context passed, and the answer/refusal — concise (decisions + I/O, not raw vectors/embeddings). Button copies to clipboard with a copied confirmation. Keep formatting in the pure module for testability.
- **Patterns to follow:** the synthesis "copy" affordances elsewhere; the indexed-trace shape from U4.
- **Test scenarios:**
  - A multi-utterance replay serializes every utterance in order with its outcome + route + reason + context.
  - A suppressed/gated utterance still appears with its suppression reason (not silently omitted).
  - Output excludes bulky/noisy fields (no raw embeddings) but includes the route reason + prior context.
  - Empty replay → a clear "no utterances" summary, not an empty string.
- **Verification:** The copied text is sufficient to diagnose the screenshot bug without the live meeting.

---

## Scope Boundaries

- **Out:** corpus/embeddings/reranker quality; **fixing** the GitHub skill-routing bug (the first thing debugged *with* this harness); production/Recall-path changes (debug-only sidecar); deterministic golden-test scoring (`corpus-eval` owns that); cross-tab/multi-user; persistence of replay sessions.

### Deferred to Follow-Up Work

- Headless **CLI replay** reusing the same driver/serializer (a la `eval/replay.ts`).
- **Before/after diff** of two replays (compare a transcript pre- and post-fix).
- Saving/sharing replay+trace bundles as files.
- Auto-loading the most recent failed meeting.

---

## Risks & Mitigations

- **Refactoring the live `final` handler breaks the mic path.** Mitigation: characterization test first (U1 execution note); the extraction is mechanical and the live handler becomes a thin caller.
- **Replay doesn't reproduce the bug (org/data drift).** The skill-vs-RAG *route* decision depends on the query + classifier + skill registry, not live GitHub data, so routing reproduces even if counts differ; replay runs in the viewer's org context (KTD5). If a bug is purely data-dependent, the trace still shows the route taken.
- **LLM non-determinism.** Temperature 0 keeps relevance/router decisions stable; accepted per KTD2. If a run doesn't reproduce, re-run — and the trace shows the decision either way.
- **Trace gaps.** U4 is an audit-then-fill; if the route/context already flow to the trace, U4 shrinks to rendering only.

---

## Acceptance / Success Criteria

- AE1 (origin): Replaying the screenshot meeting reproduces GitHub-skill-via-RAG, and each GitHub utterance's trace names the decision + reason that sent it to RAG instead of `github_count`, plus the context passed.
- AE2 (origin): After a routing fix, re-running the same transcript shows those questions routing to `github_count` — same harness, same input.
- AE3 (origin): The copied summary lets an LLM diagnose without the live meeting.

---

## Sources & Research

- Existing harness: `apps/portal/app/(authed)/debug/live-mic/{_client.tsx,_trace-panel.tsx,_pipeline-model.ts,_outputs-panel.tsx,page.tsx}` (WS client, typed `DebugEvent` union incl. `trace`/`skill-result`, per-utterance `indexTrace`/`UtteranceTrace`, stage ledger + outputs).
- Sidecar: `apps/bot-worker/src/debug/local-debug-ws.ts` (mirrors the Recall pipeline — relevance + router classifiers, skill registry, `runPipeline`, `sink-ws`; `engine.on('final')` is the per-utterance seam), `apps/bot-worker/src/pipeline/sink-ws.ts`.
- Pipeline + gates: `apps/bot-worker/src/pipeline/core.ts`, `pipeline/contract.ts`, `pipeline/answer-dedup.ts` (voiding/effective-window), `apps/bot-worker/src/retrieval.ts` (two-lane, cooldown).
- Routing (bug locus): `packages/engine/src/query-route/query-route.ts`, `packages/engine/src/router/heuristic.ts`, `packages/engine/src/skills/{index.ts,contract.ts}`; `apps/bot-worker/src/skills/github/{count,search_count,count-summary}.ts`.
- Transcript source: `apps/portal/app/_lib/transcript.ts` (`transcriptWithText`), `apps/portal/app/api/meetings/[meetingId]/events/route.ts` (decrypt+degrade pattern).
- Prior art: `apps/bot-worker/src/corpus-eval.ts` (golden-question replay through the real-time gate).
