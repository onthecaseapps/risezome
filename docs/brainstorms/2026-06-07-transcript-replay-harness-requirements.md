---
date: 2026-06-07
type: requirements
status: ready-for-planning
---

# Transcript Replay Harness (live-pipeline debug)

## Problem

Live synthesis failures are hard to reproduce and diagnose. The motivating case (dogfood meeting, screenshot): clear GitHub **skill** questions ("how many github issues are there", "what is the count of github issues", "are there any open github issues", "do we have any trial issues") were answered by **RAG over the skill's own source code** (citing `apps/bot-worker/src/skills/github/count.ts`, `search_count.ts`) instead of being routed to the `github_count` / `github_by_assignee_count` skill that actually queries the data. Several near-identical questions each produced a **separate** RAG synthesis, and the final question appeared unanswered.

These are interaction failures: the live pipeline combines the **current question with prior context + prior transcript** and runs a chain of timing- and sequence-dependent gates (relevance gate, two-lane question/ambient routing, cooldown, dedup / near-dup suppression, transcript voiding, skill-router-vs-RAG). Today they can only be reproduced **live** (slow, non-deterministic) or via `corpus-eval` (single golden questions — no cadence, no context-combining, no per-gate decision view). There is no way to replay an actual conversation through the real pipeline and see, per utterance, **which gate/decision produced the wrong outcome**.

## Goal

A **transcript replay mode** on the existing live-mic debug page: load a captured meeting's transcript + per-utterance timings, replay the utterances at faithful cadence through the **real, current pipeline**, then click any utterance to inspect every gate/step it hit (inputs incl. prior context, decisions, outputs, skill-vs-RAG + why) — and copy a structured summary to paste into an LLM for analysis and fix recommendations.

## Users

- **Primary:** the developer debugging live-pipeline behavior (reproduce a failed meeting, find the offending gate, validate a fix by re-running).
- **Secondary:** teammates iterating on gate/routing/dedup logic who need a repeatable repro loop.

## Key insight: this is an extension, not a new system

The rails already exist. The live-mic debug page (`apps/portal/app/(authed)/debug/live-mic/_client.tsx`) opens a WebSocket to a bot-worker sidecar (`apps/bot-worker/src/debug/local-debug-ws.ts`) that **mirrors the production Recall pipeline** — real relevance classifier, router classifier, skill registry, `runPipeline` from `pipeline/core.ts` — and already streams a per-utterance trace to the page (`_pipeline-model`). Today its input is mic → Deepgram. This feature **swaps the input** for a replayed transcript, **enriches the trace**, and **adds inspection + export**.

## Requirements

- **R1 — Load transcript + timings.** Two sources: (a, primary) enter a meeting ID and pull its `meeting_events` transcript (`transcript.data` rows: text, speaker, `payload.startMs`); (b, secondary) paste/upload a transcript+timings file for synthetic / shareable cases.
- **R2 — Replay at faithful cadence.** Emit finalized utterances, in order, into the same debug-pipeline path mic→Deepgram feeds. Preserve real inter-utterance gaps (the sub-30s windows that drive cooldown/dedup/two-lane), **cap long idle gaps** to a max (~5s), and expose a **speed multiplier**. (Decision below.)
- **R3 — Run the real, current pipeline each replay.** Live LLM / skill / retrieval calls through the actual relevance gate, two-lane routing, cooldown, dedup/near-dup, transcript voiding, query+context build, skill router vs RAG, retrieval, and synthesis/refusal — so **re-running after a code change validates the fix**. Not recorded/mocked outputs.
- **R4 — Per-utterance decision trace.** For each utterance, capture: relevance gate result (+ confidence/reason), lane (question/ambient), cooldown skip, dedup / near-dup / transcript-voiding decisions, the **route taken (which skill, or RAG) and the reason**, the **exact text AND prior context passed to each step**, and what each step returned (cards / skill result / synthesis / refusal).
- **R5 — Click-to-inspect.** Click any utterance in the replayed transcript to open its full trace (all of R4), mirroring the live-mic page's per-stage layout.
- **R6 — Copy summary.** Export a structured text dump of the whole replay — every utterance with its trace, decisions, and step I/O — concise but complete (inputs/decisions/outputs, not raw vectors), suitable to paste into Claude for diagnosis.
- **R7 — Replay controls.** Start / pause / restart, progress indicator, and the cadence controls from R2 (max-gap cap + speed multiplier).

## Decisions

- **Surface:** extend `debug/live-mic` page + `local-debug-ws` sidecar (reuse the real-pipeline rails). Not a new harness.
- **Run-mode:** live **current** pipeline, not recorded outputs — required so a re-run validates a fix. Accept temp-0 LLM jitter; this is a debugging loop, not a deterministic golden test.
- **Cadence:** faithful with a long-idle-gap cap + optional speed multiplier (a 16-min meeting replays in ~1–2 min without distorting the timing windows being debugged).
- **Source:** meeting ID (primary) + paste/upload file (secondary).
- **Trace must surface the exact prior context** passed into each step — context-combining is a prime suspect for both the mis-routing and the voiding/dedup behavior.

## Scope boundaries

**In:** replay + per-utterance inspection + copy-export on the debug surface; real-pipeline execution; meeting-ID and file sources; cadence controls.

**Out:**
- Corpus/embeddings/reranker quality (verified healthy elsewhere).
- **Fixing** the GitHub skill-routing bug — that is the *first thing debugged with this harness*, not part of it.
- Production / Recall-path changes (debug-only sidecar).
- Deterministic golden-test scoring (`corpus-eval` already covers golden questions).
- Cross-tab / multi-user / persistence of sessions.

**Deferred to follow-up:**
- Headless **CLI replay** (the captured trace could later power a runner like `eval/replay.ts`).
- **Before/after diff** of two replays (e.g. compare a run pre- and post-fix).
- Saving / sharing trace bundles as files.

## Success criteria

1. Replaying the screenshot meeting **reproduces** the GitHub-skill-via-RAG behavior, and the per-utterance trace names **which decision** sent each GitHub question to RAG instead of the skill (route + reason + the context that was passed).
2. After a routing fix, re-running the same transcript shows those questions now routing to `github_count` — same harness, same input.
3. The copied summary is enough for Claude to diagnose and recommend a fix **without** the live meeting.

## Dependencies & prior art

- `apps/portal/app/(authed)/debug/live-mic/_client.tsx` — page, WS client, per-utterance trace UI (`_pipeline-model`).
- `apps/bot-worker/src/debug/local-debug-ws.ts` — sidecar mirroring the real pipeline (relevance + router classifiers, skill registry, `runPipeline`, `sink-ws`).
- `apps/bot-worker/src/pipeline/core.ts` (gate + `runPipeline`), `pipeline/contract.ts`, `pipeline/answer-dedup.ts` (dedup/voiding), `pipeline/sink-ws.ts`.
- `apps/bot-worker/src/retrieval.ts` — two-lane triggering, cooldown.
- `packages/engine/src/query-route/query-route.ts` + `router/heuristic.ts` — skill-vs-RAG routing (the bug's locus).
- `packages/engine/src/skills/index.ts`, `skills/contract.ts`; `apps/bot-worker/src/skills/github/{count,search_count,count-summary}.ts`.
- `apps/bot-worker/src/corpus-eval.ts` — eval/replay prior art (golden-question replay through the real-time gate).
- Transcript source: `meeting_events` `transcript.data` rows (`payload.startMs`); decrypt pattern in `apps/portal/app/_lib/transcript.ts`.

## Open questions for planning

- **Transcript decrypt for replay-by-ID:** `meeting_events.transcript_text_enc` is encrypted at rest. Replaying a past meeting needs server-side decrypt (the sidecar or a portal endpoint) — assume reuse of the existing per-org KMS decrypt path.
- **Org/connection context:** reproducing GitHub-skill routing needs the meeting's org corpus + connections; assume the replay runs in the meeting's org context.
- **Trace richness:** confirm whether the current `_pipeline-model` / `local-debug-ws` trace already carries the route decision + the prior-context payload, or whether the sidecar must emit a richer trace (likely needs enrichment).
- **Utterance shape:** feed the finalized-utterance shape the pipeline expects (`utteranceId`, `text`, `speaker`, `startMs`).
