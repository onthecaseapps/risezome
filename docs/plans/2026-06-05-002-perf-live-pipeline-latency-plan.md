---
title: "perf: Live pipeline latency — stream synthesis, parallelize judge, single-embed"
type: refactor
status: completed
date: 2026-06-05
origin:
  - docs/brainstorms/2026-06-05-live-pipeline-latency-requirements.md
---

# perf: Live pipeline latency — stream synthesis, parallelize judge, single-embed

## Summary

Three independent latency optimizations in the bot-worker live question→answer path, each landable on its own:

- **U1 — Single embed per question.** Embed the constructed query text once and reuse the vector for both near-duplicate suppression and retrieval, eliminating one Voyage round-trip (~300–500ms) per question.
- **U2 — Parallelize the relevance judge with retrieval.** Run embed+search concurrently with the LLM judge (speculative retrieval); discard on a filler verdict. Latency on judged utterances becomes `max(judge, embed+search)` instead of their sum (~1–3s saved when the judge fires).
- **U3 — Stream the synthesis answer.** Stream prose to the live page as it generates (the answer begins appearing in ~0.5–1s instead of after the full 2–5s buffer), while preserving grounded-or-nothing — refusals are detected early via the `STATUS_` prefix and never streamed; the rare answered-but-ungrounded case is retracted.

Target: the live copilot stops "trailing the conversation." Branch from `main` (not the current `feat/structured-meeting-recap` branch) — this is bot-worker pipeline work, independent of the recap feature.

---

## Problem Frame

A grounded investigation of the live critical path established it is LLM- and round-trip-bound, and **largely serial**: per question it stacks two Voyage embeds (dedup + retrieval) + hybrid search + (when ambiguous) a pre-retrieval LLM judge + a synthesis call whose answer is **buffered in full** before anything appears. Models are already Haiku and `RISEZOME_RELEVANCE_STRICT` is OFF, so the wins are structural, not config. Three serial costs dominate the felt latency; each can be removed independently without changing the pipeline's guarantees.

---

## Requirements Traceability

Origin: `docs/brainstorms/2026-06-05-live-pipeline-latency-requirements.md`.

| Requirement | Unit |
| --- | --- |
| R3 — single embed per question (resolve embed-input unification, Q1) | U1 |
| R2 — parallelize judge with retrieval; discard on filler (Q3) | U2 |
| R1 — stream synthesis preserving grounded-or-nothing (Q2) | U3 |
| F1 (fast answer), F2 (judged-but-relevant), F3 (judged filler) | U2, U3 |
| AE1 (no partial-answer leak on grounding failure) | U3 |
| AE2 (judge overlaps retrieval) | U2 |
| AE3 (filler surfaces nothing, records no gap) | U2 |
| AE4 (exactly one query embedding) | U1 |

---

## Key Technical Decisions

**KTD1 — Unify the embed on the query text (U1, resolves Q1).** Today near-duplicate suppression embeds the raw utterance (`retrieval.ts`, pre-gate) and retrieval embeds the constructed query text (`core.ts`, via `buildQuestionQuery` + key-terms boost). Decision: build the query text **before** the dedup step (it's synchronous — safe to move ahead of the gate's atomic read-modify-write), embed it **once**, use that vector for dedup, and thread it into the pipeline so `core.ts` does not re-embed. Dedup now compares **query-text** embeddings rather than raw-utterance embeddings — a slight semantic shift that is acceptable (the query text is the utterance plus minimal context; near-duplicate detection on it is at least as meaningful). The pre-gate embed-is-the-only-async-step ordering invariant is preserved.

**KTD2 — Speculative retrieval, judge-gated commit (U2, resolves Q3).** When the judge runs, fire the judge **and** embed+search concurrently. Await both; if the judge returns filler/not-relevant, **drop** the retrieval result — emit no cards, and preserve the exact filler path (no knowledge-gap miss recorded for filler). If surface, proceed with the already-fetched results. The judge's fail-open (timeout/error → surface) is unchanged. Wasted embed+search on filler is accepted: filler is the minority and these calls are cheap relative to the ~1–3s saved. Cards must not emit until the judge verdict is in (no early surfacing of a to-be-rejected retrieval).

**KTD3 — Stream on `STATUS_ANSWER`, retract on ungrounded (U3, resolves Q2).** The synthesis output begins with a `STATUS_` prefix (`STATUS_ANSWER` / `STATUS_NO_CONTEXT`) — so the **refusal decision is known early**, before prose. Decision: detect the status prefix as the stream arrives; on `STATUS_NO_CONTEXT` (refusal), buffer and handle exactly as today (nothing revealed). On `STATUS_ANSWER`, **stream the prose deltas** to the live page (`synthesisStart` then incremental `synthesisDelta` at sentence/clause boundaries). Keep the citation grounding gate (`verifyCitationsDetailed`) at `done`. If the answer turns out ungrounded (zero verifiable citations) — the only case where prose was streamed but must not stand — emit a **retraction** that clears the streamed synthesis and records the miss, mirroring the existing stale-card retraction mechanism. Grounded-or-nothing is preserved for the common refusal case (never streamed) and enforced-by-retraction for the rare ungrounded-answer case.

**KTD4 — Sentence-boundary buffering (U3).** Stream at sentence/clause boundaries, not raw token deltas, to respect the "flash-fix" flicker concern that motivated the original whole-buffer reveal — the win is "answer starts in ~1s," not "every token flickers in."

---

## High-Level Technical Design

### U2 — judge vs. retrieval ordering (before → after)

```text
BEFORE (serial):   heuristic → [judge ~1-3s] → embed → search → cards
                                   (cards wait on judge + retrieval)

AFTER (concurrent): heuristic → ┌ judge ~1-3s ───────────┐
                                └ embed + search ~0.5-1s ─┘ → await both
                                  filler  → discard retrieval, no cards, no gap
                                  surface → emit cards from the ready retrieval
                   latency = max(judge, embed+search)
```

### U3 — synthesis streaming state (grounded-or-nothing preserved)

```text
stream arrives → detect STATUS_ prefix
  STATUS_NO_CONTEXT → buffer only → refusal at done → reveal nothing      (unchanged)
  STATUS_ANSWER     → synthesisStart → stream prose deltas (sentence-buffered)
                      → at done: verifyCitationsDetailed
                          grounded   → synthesisDone (finalize)
                          ungrounded → RETRACT streamed synthesis + recordMiss
```

---

## Implementation Units

### U1. Single embed per question (drop the double-embed)

**Goal:** Embed the query text once; reuse for near-duplicate suppression and retrieval. One Voyage round-trip saved per question.

**Requirements:** R3, AE4; KTD1.

**Dependencies:** none.

**Files:**
- `apps/bot-worker/src/retrieval.ts` (modify — build query text before the dedup embed; embed once; thread the vector into the pipeline)
- `apps/bot-worker/src/pipeline/core.ts` (modify — accept a pre-computed query embedding; skip the internal embed when provided)
- `apps/bot-worker/test/retrieval.test.ts` or the nearest existing retrieval/pipeline test (modify/create — assert single-embed)

**Approach:**
- Move `buildQuestionQuery(...)` (query-text construction) ahead of the dedup step in `maybeRetrieveAndEmit` (it's synchronous, so the gate's atomic read-modify-write is unaffected).
- Embed the query text once; use the resulting vector for the near-duplicate check (replacing the raw-utterance embed) AND pass it into the pipeline via `PipelineInput`/`PipelineDeps` so `core.ts`'s embed step is skipped when a vector is supplied.
- Keep the ambient lane (which builds a different query text) correct: the unified embed must use whatever query text that lane would have retrieved on. Confirm the key-terms boost (applied in `core.ts` at embed time, ambient-only) still lands — either apply it before the unified embed or document that the unified path subsumes it.

**Execution note:** Add a failing test asserting one embed per question before refactoring.

**Test scenarios:**
- Covers AE4. A question fires → the embedder is invoked exactly once (spy/mock count), and retrieval uses that vector.
- Near-duplicate suppression still fires: two semantically-near questions → the second is suppressed (using the query-text embedding).
- A genuinely new question after a near-dup window is NOT suppressed.
- Ambient lane: key-terms boost still influences the embedded text (no regression in what gets embedded).
- Embed failure (Voyage error) → question still fires (suppression best-effort), matching current fail-open.

**Verification:** one embedding per question; dedup + retrieval both use it; no regression in suppression behavior; bot-worker tests green.

---

### U2. Parallelize the relevance judge with retrieval

**Goal:** Run embed+search concurrently with the LLM judge; discard the retrieval on a filler verdict. Save ~1–3s on judged utterances.

**Requirements:** R2, AE2, AE3, F2, F3; KTD2.

**Dependencies:** U1 (so the concurrent embed is the single unified embed; can also land independently if U1 isn't done — note the ordering).

**Files:**
- `apps/bot-worker/src/pipeline/core.ts` (modify — restructure the judge → embed → search sequence into a concurrent judge ‖ (embed+search), then a gate on the judge verdict)
- `apps/bot-worker/test/pipeline/core.test.ts` (modify — concurrency + discard-on-filler scenarios)

**Approach:**
- Where the judge currently runs before embed+search, launch both concurrently (the judge promise and the embed+search promise). Await both.
- Branch on the judge verdict: filler → discard retrieval results, emit no cards, and do **not** record a knowledge-gap miss (preserve the AE6/filler semantics exactly — the no_hits/gap path stays gated on the judge as today, just evaluated after the concurrent fetch). Surface → continue with the fetched hits.
- Preserve fail-open: judge timeout/error → treat as surface, retrieval already done.
- Ensure no card or synthesis is emitted before the judge verdict resolves (the speculative retrieval is held, not surfaced).
- Keep the per-stage trace timings meaningful (the `stageRecord` for judge/embed/search now overlap; record actual wall-clock per stage; the trace should not imply serial timing).

**Execution note:** Characterize the current filler path (no cards, no gap) with a test before reordering, so the discard branch provably matches today's behavior.

**Test scenarios:**
- Covers AE2. An ambiguous utterance the judge passes: embed+search ran concurrently with the judge (assert via injected timing/ordering), and end-to-end latency ≈ max(judge, retrieval), not the sum.
- Covers AE3 / F3. Filler verdict → no cards emitted, no `recordMiss`/gap written, even though retrieval ran.
- F2. Surface verdict → cards emitted from the speculatively-fetched hits (identical to serial output).
- Judge timeout/error → fail-open to surface; retrieval result used; no hang.
- No card/synthesis is emitted before the judge verdict (ordering assertion).
- Non-judged path (heuristic clearly_substantive, non-strict) is unaffected — no judge call, retrieval as before.

**Verification:** judged utterances overlap judge+retrieval; filler discards cleanly with no gap; surface path output identical to before; tests green.

---

### U3. Stream the synthesis answer (grounded-or-nothing preserved)

**Goal:** Stream the synthesized prose to the live page as it generates; preserve grounded-or-nothing via early refusal detection + retract-on-ungrounded.

**Requirements:** R1, AE1, F1; KTD3, KTD4.

**Dependencies:** none (independent of U1/U2).

**Files:**
- `apps/bot-worker/src/pipeline/core.ts` (modify — `runSynthesis`: detect `STATUS_` prefix mid-stream; stream prose on `STATUS_ANSWER`; gate + retract at `done`)
- `apps/bot-worker/src/pipeline/sink-supabase.ts` (modify — incremental `synthesisDelta` broadcast during generation; a synthesis-retraction path)
- `apps/bot-worker/src/pipeline/sink.ts` or the sink interface (modify — add a synthesis-retract capability if not present, mirroring card retraction)
- `packages/engine/src/synthesize/prompt.ts` (read/possibly modify — confirm `stripStatusPrefix`/`STATUS_ANSWER`/`STATUS_NO_CONTEXT` allow early prefix detection on a partial buffer; expose a helper if needed)
- `apps/bot-worker/test/pipeline/core.test.ts` + `apps/bot-worker/test/pipeline/sink-supabase.test.ts` (modify — streaming reveal, refusal-not-streamed, ungrounded-retract)

**Approach:**
- In `runSynthesis`, accumulate deltas as today but also **inspect the buffer for the `STATUS_` prefix** as soon as it's determinable. On `STATUS_NO_CONTEXT`: do not stream; keep buffering; at `done` follow the existing refusal path (reveal nothing). On `STATUS_ANSWER`: emit `synthesisStart` once, then stream the post-prefix prose via `synthesisDelta` at sentence/clause boundaries (KTD4).
- At `done`, run the existing refusal/citation grounding gate. Grounded → `synthesisDone` (finalize the already-streamed text + citations). Ungrounded (zero verifiable citations) → emit a **synthesis retraction** clearing the streamed answer on the live page, and `recordMiss` (reason `ungrounded`) as today.
- The live page (HUD) consumes `synthesisStart`/`synthesisDelta`/`synthesisDone` + the new retraction; confirm the consumer renders incremental deltas and handles a retraction (clears the in-progress synthesis). If the HUD needs a change, note it — but the broadcast contract is the seam.
- Persisted `syntheses` row semantics: only persist/finalize the grounded answer (don't leave an ungrounded streamed answer persisted); align the DB write with the retract.

**Execution note:** Test-first on the three reveal outcomes (streamed-grounded, refusal-never-streamed, streamed-then-retracted) before changing `runSynthesis`.

**Test scenarios:**
- Covers F1. A grounded answer: `synthesisDelta` events are emitted **before** the `done` event (streaming), and the first delta lands well before full generation completes (simulate a multi-chunk stream).
- Covers AE1 (refusal). `STATUS_NO_CONTEXT` stream → no `synthesisStart`/`synthesisDelta` emitted; reveal nothing; `recordMiss` reason `refusal`.
- Covers AE1 (ungrounded). `STATUS_ANSWER` whose citations don't verify → prose was streamed, then a retraction clears it and `recordMiss` reason `ungrounded` fires; no grounded answer persists.
- Grounded answer with valid citations → streamed, then `synthesisDone` with citations; persisted `syntheses` row matches.
- Sentence-boundary buffering: deltas break on sentence/clause boundaries, not mid-token (assert chunking).
- Synthesizer error mid-stream → no partial answer left standing (clean termination, miss recorded if appropriate).

**Verification:** grounded answers stream progressively; refusals never stream; ungrounded answers are streamed-then-retracted; grounded-or-nothing holds; tests green.

---

## Scope Boundaries

### In scope
The three optimizations above in the bot-worker live pipeline + its realtime broadcast contract, with the HUD consuming the (already-existing) synthesis delta/retract events.

### Deferred to Follow-Up Work
- Reranker gating + optimistic card emission (skip rerank on strong hits; emit cards before enrich/parent-doc) — separate pass with a precision tradeoff.
- Dev-mode fast path (default rerank/parent-doc OFF locally, ON in prod).
- Folding the judge into the synthesis call (one Anthropic round-trip).

### Out of scope
- The regression hunt ("what changed recently") — set aside in favor of forward improvement.
- Transcription ingest latency (Recall WS → transcript display).
- Model/config changes (already Haiku + strict-off).

---

## Risks & Dependencies

- **R1 — Grounded-or-nothing must not regress (U3).** The whole guarantee is that an ungrounded/refused answer never stands. Mitigation: refusals detected early via `STATUS_` prefix and never streamed; ungrounded answers retracted; the three reveal outcomes are test-first. This is the highest-risk unit — review the retract path carefully.
- **R2 — HUD consumer parity (U3).** If the live page doesn't already render incremental `synthesisDelta` or handle a synthesis retraction, it needs a matching change; the broadcast contract is the seam, but verify the consumer end-to-end.
- **R3 — Filler semantics under speculation (U2).** The discard branch must exactly preserve "filler → no cards, no gap." Mitigation: characterize current behavior first; ordering assertion that nothing emits pre-verdict.
- **R4 — Dedup semantic shift (U1).** Comparing query-text embeddings (vs raw-utterance) slightly changes near-duplicate detection; acceptable per KTD1, covered by suppression tests.
- **D1 — Existing delta infra.** `synthesisStart`/`synthesisDelta`/`synthesisDone` already exist (currently effectively buffered) — U3 builds on them, plus a new retract event.
- **D2 — Branch from `main`**, independent of `feat/structured-meeting-recap`.
- **D3 — No new external dependencies**; all three restructure existing control flow + the existing Voyage/Anthropic clients.

---

## Sources & Research

- Origin: `docs/brainstorms/2026-06-05-live-pipeline-latency-requirements.md`.
- Grounding (this session's critical-path investigation): `apps/bot-worker/src/retrieval.ts` (lane routing, dedup embed, gate), `apps/bot-worker/src/pipeline/core.ts` (`runPipeline` judge→embed→search→synthesis; `runSynthesis` buffering + grounding gate), `apps/bot-worker/src/corpus-search.ts` (hybrid search + rerank), `apps/bot-worker/src/pipeline/sink-supabase.ts` (`synthesisStart/Delta/Done`, card retraction), `packages/engine/src/synthesize/prompt.ts` (`parseSynthesisOutput`, `stripStatusPrefix`, `STATUS_ANSWER`/`STATUS_NO_CONTEXT`, `verifyCitationsDetailed`).
