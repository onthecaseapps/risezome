---
date: 2026-06-04
topic: live-retrieval-triggering
---

# Live Retrieval Triggering & Query Construction

## Summary

Replace the live meeting's single blind retrieval throttle with a **two-lane triggering policy**: a substantive **question** always fires retrieval + synthesis immediately (no time cooldown, no "about-our-work" pre-filter — the synthesizer grounds or cheaply refuses), while proactive **ambient** context-surfacing stays cost-budgeted. A high abuse ceiling backstops runaway question volume, near-duplicate questions are suppressed within a meeting, and a question's retrieval query is **anchored on the question utterance** (plus minimal context) instead of a blind concatenation of recent speech.

## Problem Frame

The live pipeline (`apps/bot-worker/src/retrieval.ts`, `maybeRetrieveAndEmit`) fires retrieval at most once per `COOLDOWN_MS = 10s`, on whichever utterance happens to cross the cooldown boundary. The cooldown is topic-blind and first-come: it spends the 10s "slot" on whatever utterance arrives first — usually filler — then silently throttles out anything that follows.

This was root-caused from a real incident: a user asked "what ai models do we use" live and got nothing. An off-domain filler utterance had triggered a retrieval 3.9s earlier, so the question landed inside the cooldown and was dropped (`return { skipped: 'cooldown' }`) with no log, no synthesis, no card. Verified separately: the corpus is healthy and the synthesizer grounds this exact question when it actually runs (the corpus eval passes it). So the failure was purely *when* we decided to retrieve — the question never entered the pipeline.

A second, related weakness surfaced in the same investigation: the retrieval query is the last `WINDOW_UTTERANCES = 8` final utterances concatenated (`recentFinals.join(' ')`). A clean question asked amid an unrelated conversation is embedded as the question plus seven off-domain lines, pulling retrieval toward the wrong domain. It did not cause this specific miss (the question never ran), but it degrades retrieval quality whenever a question is asked during off-topic talk.

The cost of getting this wrong is high and invisible: the assistant's core promise is answering the question you just asked, and a silent drop reads as "it doesn't work." The cooldown exists for a real reason — each fire costs a Voyage embed + hybrid search + Claude synthesis — so the fix must bound cost without dropping questions.

## Key Decisions

- **Two lanes, split by intent.** Separate "answer the question the user asked" (QUESTION lane) from "proactively surface relevant context as people talk" (AMBIENT lane). The lanes have independent triggering rules because they have different value and different acceptable cost. The single shared throttle was conflating them.

- **Budget the expensive step, not the entry.** The costly operation is synthesis (Claude), which only runs for non-filler anyway — filler is already cheaply gated out. The current cooldown throttles at the entry, penalizing questions to save cost on fires synthesis would never have run. Cost control moves to guard synthesis fires, with questions prioritized.

- **Questions are never throttled in normal use; a high ceiling backstops abuse.** A detected substantive question fires immediately. A deliberately high per-minute / per-meeting ceiling — set well above any normal conversational question rate — protects against runaway loops or abusive volume. Normal meetings never reach it.

- **The QUESTION lane skips the "about-our-work" relevance judge.** Gate only on "is this a substantive question someone wants answered" (interrogative, not filler/rhetorical), then retrieve and let the synthesizer be the relevance backstop (ground-or-refuse). This avoids the ambiguity trap that dropped "what ai models do we use" ("we" read as possibly the customer's business). Worst case is a cheap refusal on an off-topic question; an answerable question is never dropped before retrieval.

- **Question query is anchored on the question, not the rolling window.** Embed the question utterance as the primary query, weighted to dominate, with a small bounded slice of recent context only to resolve fragments and pronouns ("what about the second one?"). No LLM rewrite. This removes off-domain dilution while preserving follow-up resolution.

- **Suppress near-duplicate questions within a meeting.** A genuinely new question always fires; a question semantically close to one already answered this meeting (within a recency window) is suppressed, so repeats and rephrasings don't re-answer or re-spend.

## Requirements

**Triggering — Question lane**

- R1. A substantive question detected on a finalized utterance fires retrieval + synthesis regardless of the time since the last retrieval (no cooldown gating on questions).
- R2. Question-lane firing does not depend on an "about-our-work" / corpus-relevance judgment. The relevance backstop is the synthesizer, which grounds or refuses.
- R3. Filler and rhetorical questions (e.g., "right?", "you know?") must not qualify as substantive questions and must not fire the lane.
- R4. When the synthesizer declines (no relevant corpus context), the outcome is a silent no-op for the user — no card, consistent with today's refusal behavior.

**Triggering — Ambient lane**

- R5. Proactive (non-question) context-surfacing continues to fire on substantive non-question speech, gated by the existing relevance gate, and remains cost-budgeted on its own throttle.
- R6. The ambient throttle/budget must never block a QUESTION-lane fire — the lanes are independent.

**Cost limits & de-duplication**

- R7. A high safety ceiling bounds question-lane synthesis volume (per-minute and/or per-meeting), set well above normal conversational question rates so ordinary meetings never reach it.
- R8. When the ceiling is exceeded, excess question fires are throttled (not guaranteed) rather than allowed to run unbounded; normal use must not be affected.
- R9. A question semantically near one already answered in the current meeting (within a recency window) is suppressed; a genuinely new question always fires.

**Query construction**

- R10. For a QUESTION-lane fire, the retrieval query is anchored on the question utterance as the primary signal, weighted to dominate the embedding.
- R11. A small, bounded slice of recent context may be included only to resolve fragments/pronouns/follow-ups; it must not dominate or dilute the question's embedding.
- R12. AMBIENT-lane fires retain a wider rolling-window query (proactive surfacing benefits from the broader recent span).

**Scope safety**

- R13. The Recall (production) path and the local-audio dogfood path share this triggering logic; both inherit the new behavior identically.

**Eval-surface visibility**

- R14. The corpus eval Run output (`/debug/eval`) surfaces the triggering verdict for the evaluated question, alongside the existing synthesis + citations: whether the utterance is classified as a substantive question, which lane it takes (QUESTION / AMBIENT / skipped-as-filler), and — where state is modeled — its dedup and ceiling status.
- R15. The eval's triggering verdict is computed from the SAME classification logic the live path uses (no eval-only heuristic), so the eval faithfully mirrors what live would do and a golden-question pass implies live would fire correctly.
- R16. Filler / rhetorical golden examples surface a "would not fire" verdict, so the eval validates both that real questions fire and that non-questions don't.

## Acceptance Examples

- AE1. **Covers R1.** A question is asked 3.9s after a prior (filler) retrieval. Result: the question fires retrieval + synthesis — it is NOT skipped by a cooldown. (This is the exact incident that motivated the change.)
- AE2. **Covers R2, R4.** An off-topic question with no corpus answer is asked. Result: the lane fires, the synthesizer refuses, the user sees nothing — a cheap refusal, not a dropped question.
- AE3. **Covers R3.** "...right?" / "you know what I mean?" arrive as utterances. Result: no question-lane fire.
- AE4. **Covers R9.** The same question is asked twice within the recency window. Result: the first answers; the second is suppressed. A rephrasing into a genuinely different question answers.
- AE5. **Covers R7, R8.** A pathological burst (e.g., a list of many questions read aloud) exceeds the ceiling. Result: fires up to the ceiling, then throttles excess; a normal 2–3-question exchange is unaffected.
- AE6. **Covers R10, R11.** A clean question is asked amid unrelated off-domain talk. Result: retrieval reflects the question, not the surrounding domain. A fragment follow-up ("and historically?") still resolves against minimal prior context.
- AE7. **Covers R14, R15, R16.** A golden question Run on `/debug/eval` shows "QUESTION lane — fires" above its synthesis; a filler/rhetorical golden example shows "would not fire" with no synthesis. Both verdicts come from the same classifier the live path uses.

## Success Criteria

- A substantive question asked in a live meeting always produces a synthesis attempt (grounded answer or silent refusal), independent of surrounding speech or recent retrieval timing.
- Retrieval for a question reflects the question's topic, not the dominant topic of surrounding conversation.
- Cost stays bounded under normal use; only pathological/abusive volume hits a limit.
- A regression test reproduces the original failure mode: a clear question arriving within the old cooldown window after a filler retrieval must fire (fails on today's code, passes after the change), plus a golden "question amid filler" eval scenario.

## Scope Boundaries

- Out: corpus coverage, embeddings, hybrid search, the reranker, and synthesizer prompt/quality — all verified healthy during the debug. This work changes *when* we fire and *what query* we build, not retrieval or synthesis internals.
- In (UI): extending the corpus eval page (`/debug/eval`) to display the triggering verdict (R14–R16). The live meeting HUD is NOT changed in this scope — eval-surface visibility only.
- Out: an explicit wake-phrase / direct-address invocation model (considered and rejected — it loses the passive copilot value).
- Out: an LLM query-rewrite step for question normalization (considered; deferred in favor of the cheaper question-anchored-plus-context approach).

## Outstanding Questions

**Deferred to Planning**

- Exact ceiling values (per-minute / per-meeting) and the over-cap behavior (drop excess vs. temporarily fall back to the ambient throttle) — tune with sensible defaults.
- The concrete signal for "substantive question" (the existing `classifyRelevanceHeuristic` + LLM judge in `apps/bot-worker/src/pipeline/core.ts` already classify filler vs. substantive; planning determines how to derive the question/interrogative signal and where the about-our-work judgment is bypassed for the question lane).
- The size/shape of the minimal context slice for fragment resolution (R11) and the question-vs-context weighting (R10).
- The near-duplicate similarity threshold and recency window for R9.
- Whether the eval shows triggering as a per-question classification only, or models a question sequence to exercise dedup/ceiling state (R14) — the former is sufficient for the primary lane/question verdict.

**Possible future direction (not blocking)**

- Whether the AMBIENT lane should eventually be minimized toward question-answering only — it is the lower-value, noise-prone path (the side-conversation card noise flagged previously). For now it is kept, budgeted and gated.

## Sources / Research

- `apps/bot-worker/src/retrieval.ts` — `maybeRetrieveAndEmit`, `COOLDOWN_MS = 10s`, `UTTERANCE_THRESHOLD = 1`, `WINDOW_UTTERANCES = 8`, `recentFinals`. The cooldown skip path returns without logging.
- `apps/bot-worker/src/pipeline/core.ts` — the relevance gate (`classifyRelevanceHeuristic` + relevance-classifier judge), CRAG expansion, and the synthesizer invocation.
- The corpus eval harness (`apps/bot-worker/src/corpus-eval.ts`, portal `/debug/eval`) — proves the question grounds when actually run; it shares `runPipeline` with the live path but without the cooldown.
- Debug verification: the question utterance produced zero pipeline log lines (cooldown skip), corpus is intact (536 docs / 1254 chunks / 0 null embeddings), and direct synthesizer tests grounded the question on the real sources under all input variations.
