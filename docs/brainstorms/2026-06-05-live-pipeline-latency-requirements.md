# Live Pipeline Latency Improvements

**Created:** 2026-06-05
**Status:** Requirements (ready for `/ce-plan`)
**Topic:** Cut the perceived latency of the live question→answer path in the bot-worker pipeline via three independent, compatible optimizations: **stream the synthesis answer**, **parallelize the relevance judge with retrieval**, and **drop the question-lane double-embed**.

> Forward-looking optimization (not a regression hunt). A grounded investigation of the live critical path established that the pipeline is **LLM- and round-trip-bound**: per question it stacks 2–3 Voyage embeds/reranks + 1–2 Anthropic calls (judge + synthesis), largely serial, and the synthesized answer is buffered whole before it appears. Models are already Haiku and `RISEZOME_RELEVANCE_STRICT` is OFF, so this is about the *structure* of the path, not config.

---

## Problem Frame

On the live page, the answer to a question "trails the conversation" — it appears **all at once** several seconds after the question, and cards are gated behind work that could run in parallel. Three structural costs dominate the felt latency:

1. **Synthesis is buffered whole.** The Anthropic synthesis (~2–5s) accumulates the entire response and only broadcasts on the `done` event (a deliberate "flash-fix" choice to avoid flicker). Nothing of the answer shows until it's complete.
2. **The relevance judge blocks retrieval.** When it fires (ambiguous utterances) the judge (~1–3s) runs *before* embed+search, so cards wait on a verdict that could be computed alongside the retrieval it gates.
3. **The question lane embeds twice.** Near-duplicate suppression embeds the question, then retrieval embeds again — two Voyage round-trips (~300–500ms each) for one question.

---

## Core Outcome

A question surfaces **cards in under ~1s** and the **answer streams in right behind** (first tokens ~0.5–1s instead of a 2–5s silent wait). On the utterances where the judge fires, the judge no longer adds its full cost on top of retrieval. Net: the live copilot stops feeling "behind."

---

## Requirements

### R1 — Stream the synthesis answer
- The synthesized answer is **streamed to the live page progressively** (sentence-level granularity) instead of being buffered in full and broadcast once on completion.
- The grounded-or-nothing guarantee is **preserved**: an ungrounded/refused synthesis must still surface nothing (so streaming cannot leak a partial answer that later fails the citation/grounding gate). Planning must resolve how progressive streaming coexists with the post-hoc grounding check — e.g. stream only after the grounding signal is established, or buffer to a safe boundary then stream the remainder.
- Flicker is bounded by streaming at **sentence/clause boundaries**, not raw token deltas (the "flash-fix" concern that motivated the original whole-buffer is respected, not discarded).

### R2 — Parallelize the relevance judge with retrieval
- When the relevance judge runs, **embed + hybrid search run concurrently** with it (speculative retrieval) rather than strictly after.
- If the judge returns **filler/not-relevant**, the speculative retrieval result is **discarded** (no cards emitted, gap-miss behavior unchanged — filler still never becomes a knowledge gap).
- If the judge returns **surface**, the already-fetched retrieval is used immediately. Net latency for a judged utterance becomes **max(judge, embed+search)** instead of their sum.
- The judge's existing **fail-open** behavior (on timeout/error → surface) is preserved.

### R3 — Drop the question-lane double-embed
- A question is embedded **once** for both near-duplicate suppression and retrieval, eliminating one Voyage round-trip per question.
- **Open question for planning (see Q1):** the two embeds currently have *different inputs* — dedup embeds the raw utterance; retrieval embeds the constructed query text (question + recent context via `buildQuestionQuery`). Planning must decide whether to unify on one input (embed the query text once, use it for dedup too — slightly changes dedup semantics) or otherwise share the embed. The saving is only real once this is resolved.

---

## Key Flows

- **F1 — Fast answer.** A question fires → cards appear in <1s → the answer streams in sentence-by-sentence rather than after a multi-second silence.
- **F2 — Judged-but-relevant question.** Judge + retrieval run in parallel; judge says surface; cards/answer proceed with no added judge wait.
- **F3 — Judged filler.** Judge + retrieval run in parallel; judge says filler; the speculative retrieval is dropped; nothing surfaces and no gap is recorded.

---

## Acceptance Examples

- **AE1.** For a grounded answer, the first answer content reaches the live page **before** the full synthesis completes (streaming), and a later grounding failure can never have leaked a partial answer. *(R1)*
- **AE2.** On an ambiguous utterance that the judge passes, end-to-end question→cards latency is **not** the sum of judge + retrieval — retrieval overlaps the judge. *(R2)*
- **AE3.** A filler utterance routed to the judge surfaces no cards and records no knowledge-gap miss, even though retrieval ran speculatively. *(R2, R3-unaffected)*
- **AE4.** A question triggers exactly **one** query embedding, not two. *(R3)*

---

## Scope Boundaries

### In scope
The three optimizations above (stream synthesis, parallelize judge, single-embed), in the bot-worker live pipeline + its realtime broadcast to the live page.

### Deferred to follow-up
- **Reranker gating / optimistic cards** (#4/#5 from ideation: skip rerank when hits are strong, emit cards before enrich/parent-doc) — real wins (~300–700ms) but a separate pass with a precision tradeoff to evaluate.
- **Dev-mode fast path** (default rerank/parent-doc OFF locally, ON in prod) — a cheap iteration-speed nicety.
- **Folding the judge into synthesis** (one Anthropic call instead of two) — larger redesign.

### Out of scope
- The **regression hunt** ("what changed recently") — intentionally set aside in favor of forward improvement.
- **Transcription ingest** latency (Recall WS → transcript display) — the live transcript path, distinct from question→answer.
- Model/config changes (already Haiku + strict-off).

---

## Open Questions (for planning)

- **Q1 — Embed input unification (R3).** Do we embed the constructed query text once and reuse it for near-duplicate suppression (changing dedup to compare query-text embeddings instead of raw-utterance embeddings), or share the embed some other way? The dedup window semantics shift slightly; confirm that's acceptable.
- **Q2 — Streaming vs the grounding gate (R1).** What's the safe streaming boundary that preserves grounded-or-nothing? Options: stream only once at least one citation is verified; stream after a short buffer; or stream and retract on a grounding failure (worse UX). Planning to pick.
- **Q3 — Speculative-retrieval waste (R2).** Acceptable cost ceiling for running embed+search on utterances the judge then rejects? (Expected low — filler is the minority and embed+search are cheap vs. the latency saved — but worth stating.)

---

## Dependencies & Assumptions

- **D1 — Realtime delta infra exists.** The sink already emits `synthesisStart`/`synthesisDelta`/`synthesisDone` events (currently the deltas are effectively buffered); R1 builds on this, not net-new transport.
- **D2 — Judge fail-open + gap-miss semantics are load-bearing** and must survive R2's reordering (filler never becomes a gap; timeout → surface).
- **D3 — Haiku + strict-off** is the assumed config; these optimizations are independent of model choice.
- **D4 — No new external dependencies**; all three are restructurings of existing bot-worker control flow + the existing Voyage/Anthropic clients.
