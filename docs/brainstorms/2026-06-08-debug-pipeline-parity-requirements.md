---
date: 2026-06-08
status: active
type: feat
---

# feat: Debug Pipeline Parity — make the live-mic / replay debug page match production

## Summary

The local-mic / transcript-replay debug page should reflect the **production live pipeline exactly** — the same answer-or-suppress decision for every utterance, plus a visible reason for each — so it is trustworthy for diagnosing live issues. We achieve this by running the debug session through the **real production retrieval adapter** (`apps/bot-worker/src/retrieval.ts` `maybeRetrieveAndEmit`) instead of the current partial replica, eliminating drift by construction (single code path).

This is a fidelity follow-on to the transcript-replay harness (see prior art: `docs/brainstorms/2026-06-07-transcript-replay-harness-requirements.md`, `docs/plans/2026-06-07-001-feat-transcript-replay-harness-plan.md`). It does **not** change production retrieval behavior.

---

## Problem Frame

The debug sidecar (`apps/bot-worker/src/debug/local-debug-ws.ts`) calls the pipeline **core** (`runPipeline`) directly and hand-rolls a *partial* copy of the production adapter's gate stack. Production's `maybeRetrieveAndEmit` applies a full gate stack — two-lane question/ambient classification, question-anchored query build, semantic near-duplicate-question suppression, per-minute/per-meeting question ceiling, 10s cooldown, utterance threshold, and the meeting-scoped effective-source-set filter — **before** calling `runPipeline` with the Supabase sink.

Because the debug path skips most of those gates, a replayed meeting **over-answers** (every rephrasing of a question re-synthesizes) and the debug view diverges from what production actually does. This was discovered live: replaying meeting `6675501a` produced ~4 answers to one conversational thread that production would have suppressed. A partial fix (the near-duplicate-question gate) was already wired into the debug path on branch `fix/github-skill-misroute` — but partial replication is exactly the drift this brainstorm exists to end.

**Who is affected:** the developer/operator using the debug page to diagnose live synthesis behavior (routing, dedup, suppression). The debug page is internal tooling; its entire value is being a faithful mirror of prod.

---

## Actors

- **A1 — Debug operator.** A developer replaying a captured meeting (or talking into the live mic) to understand why the live pipeline answered, suppressed, or mis-routed an utterance, and to validate fixes.

---

## Key Flows

- **F1 — Replay a captured meeting.** Operator loads a past meeting's transcript by ID, plays it through the debug pipeline, and inspects each utterance's gate-by-gate trace + copies a summary. Retrieval is scoped to that meeting's sources; gates fire as they did in the real meeting.
- **F2 — Live-mic sandbox.** Operator talks into the mic with no meeting selected. Retrieval runs whole-org (unscoped); the session is clearly labeled as a non-parity sandbox.

---

## Requirements

- **R1 — Single code path (behavior parity).** The debug session runs the production retrieval adapter (`maybeRetrieveAndEmit`), not a separate replica. Given the same inputs, the debug path makes the **same** answer-or-suppress decision production would for every utterance (subject only to LLM non-determinism at temperature 0).
- **R2 — Observability parity.** Every gate decision is visible in the existing per-utterance trace panel and the copied summary: two-lane classification, near-duplicate-question suppression, question ceiling, cooldown, utterance threshold, the relevance/router/retrieval/synthesis core stages, AND the resolved retrieval scope. A suppressed utterance shows *why* it was suppressed — never a bare "no trace / nothing happened."
- **R3 — Sink injection.** The production adapter is refactored so the output sink is injectable: production passes the Supabase sink; the debug path passes the WS + trace sink. The sink's grounded-answer hook stays wired to the adapter's runtime-recording (answered-questions / consumed-finals / answered-source-sets), so dedup state is maintained identically on both paths.
- **R4 — Injectable logical clock.** The adapter's time-based gates (cooldown, question ceiling, near-duplicate recency window) read an injectable "now". Replay supplies the utterance's meeting-logical time (`startMs`) so replay *speed* never changes which utterances suppress; live-mic and production use real wall-clock time.
- **R5 — Meeting-scoped retrieval for replay.** Replay threads the real meeting ID through to the adapter so retrieval is scoped to that meeting's effective source set, identically to production.
- **R6 — Whole-org sandbox for live-mic.** When no meeting is selected (live-mic), retrieval runs whole-org (today's behavior) and the trace/summary labels the session "unscoped (no meeting)" so a whole-org result is never mistaken for parity.
- **R7 — Remove the hand-rolled replication.** The debug sidecar's parallel copy of the gate/dedup logic (Mechanism A/B voiding + source-set dedup, the question-dedup wiring, and the per-connection state it kept) is deleted once the shared adapter owns it. No behavior should live in two places.
- **R8 — Production behavior preserved.** Production retrieval behavior is unchanged. `apps/bot-worker/test/retrieval.test.ts` and `apps/bot-worker/test/retrieval-safety-net.test.ts` are the safety net and must stay green throughout.

---

## Acceptance Examples

- **AE1 (F1, R1, R2).** Replaying meeting `6675501a`: the conversational thread "is the transcript working / and is it quicker / taking a while / not sure if it's working" produces **one** answer plus suppressed follow-ups, each suppressed utterance showing `cooldown` or `near-duplicate-question` as the reason — matching what production did, not four separate answers.
- **AE2 (R2).** A cooldown-, ceiling-, or threshold-suppressed utterance renders a trace with the responsible gate marked as the stop, and the copied summary names that gate — no utterance produces a blank "no trace".
- **AE3 (R4).** Replaying the same meeting at 1× and at 4× speed yields the **same** set of answered vs suppressed utterances (logical-time gating).
- **AE4 (R5/R6).** A replayed meeting's trace shows retrieval scoped to that meeting's sources; a live-mic session's trace shows "unscoped (no meeting)".
- **AE5 (R8).** The production retrieval test suites pass unchanged after the refactor.

---

## Key Decisions

- **KD1 — Approach 1: collapse onto the prod adapter (single code path).** Chosen over (a) keeping separate paths with a CI parity test, and (b) capture-and-compare against real prod logs. Rationale: drift already bit us once; a single path makes it structurally impossible and is the lowest *ongoing* carrying cost, even though it touches the live path now. Approach 2 re-introduces the fork; Approach 3 is a heavier, different product (forensic incident comparison) that can layer on later.
- **KD2 — Parity means behavior AND observability.** Same decisions as prod, and every gate decision visible. Both, not either.
- **KD3 — Logical time for replay gates.** Replay drives time-based gates off meeting-logical `startMs`, not the compressed replay wall-clock, so replay speed doesn't distort suppression. (See R4.)
- **KD4 — Live-mic stays whole-org, honestly labeled.** No-meeting sessions can't fully match prod (prod always runs inside a meeting); rather than invent a meeting-picker, keep whole-org and label it a non-parity sandbox. (See R6.)
- **KD5 — Production behavior is frozen.** This is a debug-fidelity change. The gate threshold values and prod retrieval behavior are out of scope; the retrieval tests guard them.

---

## Scope Boundaries

### In scope
- Refactor `maybeRetrieveAndEmit` for sink injection + injectable clock (behavior-preserving for prod).
- Route the debug sidecar through the refactored adapter; delete the hand-rolled replica.
- Thread the real meeting ID through the WS replay protocol for meeting-scoped retrieval.
- Surface every adapter gate decision (incl. the pre-pipeline skips and the resolved source scope) in the trace + summary.

### Deferred to Follow-Up Work
- A live-mic meeting-picker (borrow a meeting's source scope for the sandbox) — only if no-meeting parity becomes a real need.
- Capture-and-compare against real production gate-decision logs (Approach 3) — forensic incident diffing.
- Headless CLI replay reusing the unified path.

### Outside this product's identity
- Changing production retrieval **behavior** or any gate threshold value.
- Making the live-mic-without-a-meeting mode claim production parity.

---

## Success Criteria

- Replaying a captured meeting reproduces production's answer/suppress pattern (no over-answering), validated against the `6675501a` case (AE1).
- Every utterance — answered or suppressed — has a complete, legible gate-by-gate trace; no blank "no trace" for a suppressed utterance (AE2).
- Replay speed does not change which utterances suppress (AE3).
- The production retrieval test suites pass unchanged (AE5).
- There is exactly one implementation of the gate/dedup/scope logic (no parallel replica remains).

---

## Dependencies & Prior Art

- Builds on branch `fix/github-skill-misroute`: `apps/bot-worker/src/pipeline/question-trigger.ts` (shared question-lane helpers already extracted), the replay handler's near-duplicate-question gate, and the `question-dedup` trace stage already added to the trace model.
- Reuses the transcript-replay harness rails: the debug page (`apps/portal/app/(authed)/debug/live-mic/`), the WS sidecar (`apps/bot-worker/src/debug/local-debug-ws.ts`), the trace model (`_pipeline-model.ts`), and the WS+trace sink (`apps/bot-worker/src/pipeline/sink-ws.ts`).
- Production adapter under refactor: `apps/bot-worker/src/retrieval.ts` (`maybeRetrieveAndEmit`, `RetrievalRuntime`). Safety net: `apps/bot-worker/test/retrieval.test.ts`, `apps/bot-worker/test/retrieval-safety-net.test.ts`.
- `engine`/`crypto` are consumed as built dist — rebuild on src change before portal/bot-worker typecheck or tests.

---

## Open Questions (deferred to `/ce-plan`)

- **OQ1 — Gate-skip trace emission location.** Emit trace events for pre-pipeline gate skips (cooldown/ceiling/threshold/near-dup/empty/scope) from inside the shared adapter (prod's no-trace sink no-ops them) vs from a thin debug-only wrapper that translates the adapter's `skipped` return into a trace event. A how-question; the product requirement (R2) is that they are visible.
- **OQ2 — Sink-injection shape.** Factory callback vs passing a constructed sink vs a small strategy object. Implementation detail for planning.
- **OQ3 — Meeting-ID threading mechanism.** Carry the meeting ID on the existing `replay-reset` WS message vs a new handshake field. Planning detail.
- **OQ4 — `RetrievalRuntime` lifecycle in the debug session.** One runtime per WS connection, reset on `replay-reset`; confirm this matches the per-meeting lifetime prod assumes.
