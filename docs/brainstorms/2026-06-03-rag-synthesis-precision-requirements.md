# RAG synthesis precision — suppress side-conversation, surface real questions

Created: 2026-06-03

## Problem Frame

The meeting copilot listens to live transcripts and surfaces grounded answer **cards** (real-time) and **syntheses** (post-meeting) from an indexed corpus. The corpus is **this project's own source code + documentation**. In practice the pipeline surfaces too many cards from **side conversations** — small talk and topically-adjacent chatter that isn't an actual question and isn't about our code/products/work. A confidently-surfaced card for "did anyone watch the game?" or for a generic React question we have no stake in is noise that erodes trust in the cards that matter.

Every gate in the current pipeline is deliberately **fail-open**: the relevance judge says "when in doubt, surface" and only skips at ≥70% noise-confidence; retrieval floors are a very low rank-fusion cutoff (RRF 0.012/0.025); the synthesis prompt answers "whenever the sources touch the topic at all, even tangentially." That design optimizes recall at the cost of precision, and there is **no classifier for "is this even about our stuff?"**

The goal: raise precision — suppress off-topic and adjacent-but-not-ours utterances — **without over-refusing genuine questions**. Recent research shows vanilla RAG over-refuses up to ~35.5% on all-irrelevant context, so tightening cuts both ways and must be measured in both directions.

## Who This Is For

The **meeting participant** who asks (or doesn't ask) something out loud and glances at a card. They speak naturally; chit-chat, tangents, and generic questions bleed into the conversation. They can't proofread the copilot mid-meeting, and a stream of off-topic cards trains them to ignore the surface entirely. What changes for them: cards become trustworthy because the system surfaces when something is genuinely about our work and stays quiet otherwise — and it still answers their real questions about our code and docs.

## Requirements

- **R1 — Suppress off-topic.** Ordinary small talk / chit-chat (no question, not about our work) must not surface a card.
- **R2 — Suppress adjacent-but-not-ours.** Utterances topically near corpus subjects but not actually about our code/docs (and not answerable from them) must not surface a card, even when retrieval finds tangential matches. These hard negatives are what leaks today.
- **R3 — "About-our-work" decision.** The system gains an explicit decision about whether an utterance is about our products/codebase/work — the gap that lets adjacent chatter through today.
- **R4 — Absolute relevance gate.** An absolute per-card relevance grade replaces the rank-based RRF floor as the surface/suppress decision (RRF still used for ranking). Off-task content inside a topically-adjacent hit must not, by itself, trigger or pad a card.
- **R5 — First-class, honest abstention.** The synthesizer can decline ("no relevant context") without the bar being so high that tangential matches always answer. Refused/ungrounded items still become knowledge gaps (existing behavior preserved).
- **R6 — Recall guardrail.** Genuine questions about our code/docs must still surface a grounded card. Over-refusal on real questions must not increase by more than ~2–3 points on any single change.
- **R7 — Latency budget.** Every change keeps the real-time path within its budget (~3s window). A change that blows latency is reverted regardless of precision gains.
- **R8 — Incremental + reversible.** Each change lands one at a time, behind a flag where feasible, gated by a fresh eval run, kept-or-reverted on the numbers (precision-first, recall-guarded, latency-bounded).
- **R9 — Eval set exists first.** A synthetic, labeled, version-controlled eval set that exercises the full real-time path is built **before** any tuning, and measures precision, over-refusal, and latency. (See Eval Dataset Design.)

## Eval Dataset Design (first-class deliverable)

The eval set is the foundation — it must exist and be trustworthy before any pipeline change ships, so every change is keep-or-revert on real numbers.

**Synthetic is fine.** Utterances are generated to plausibly occur in a normal working meeting; they do **not** need to come from real transcripts.

**Three labeled buckets, each with an expected outcome:**

| Bucket | Contents | Expected outcome |
|--------|----------|------------------|
| **1 — Not relevant** | Ordinary off-topic chit-chat / small talk | **Suppress** (no card) |
| **2 — Adjacent, not ours** | Topically near corpus subjects but not about our code/docs and not answerable from them (the hard negatives) | **Suppress** (no card) |
| **3 — Relevant** | Genuine questions about *this repo's* source code + documentation | **Surface** a grounded card (cite the right doc, answer contains expected facts) |

**Per-item label:** `surface` vs `suppress`; for `surface`, the doc(s) it should ground in + expected answer substrings. This extends the existing golden-set format (`must_surface`, `expect_answer_contains`, `expect_refusal`) with a bucket tag.

**Measured end-to-end through the full path** (heuristic gate → relevance judge → retrieval → synthesis). "Surfaced" = a card/answer actually came out. This is what makes the gate-level changes measurable — the harness must invoke the relevance gate, which today it may skip.

**Metrics:**
- **Precision** — of items that surfaced, the fraction that were bucket 3 (true positives vs bucket 1/2 false positives).
- **Over-refusal / recall** — of bucket 3, the fraction wrongly suppressed (the guardrail).
- **Latency** — p50/p95 per item across the full path.

**Scale (default, adjustable):** keep/expand the existing ~65 relevant items; add ~30–40 bucket-1 and ~30–40 bucket-2 negatives.

**Storage:** extend `apps/bot-worker/eval/golden-questions.jsonl` (or a parallel labeled file) and the `apps/bot-worker/src/corpus-eval.ts` scorer; version-controlled, ties to the team's eval-regression-coverage practice and the `/debug/eval` page.

## Key Decisions

- **KD1 — Precision-first, recall-guarded acceptance.** Keep a change only if precision rises AND over-refusal rises by ≤~2–3 pts AND latency stays within budget. (User choice.)
- **KD2 — Eval runs the full real-time path**, not retrieval-only, so gate-level suppression (the biggest lever) is measurable. (User choice.)
- **KD3 — Eval-first.** Build the labeled three-bucket set before any tuning. (User choice.)
- **KD4 — One change at a time, flag-gated, keep-or-revert** on a fresh eval run. (User choice.)
- **KD5 — Absolute grading replaces the RRF floor for the gate.** Research: bi-encoder/RRF scores are query-dependent, so a fixed fusion floor is an unreliable precision proxy; RRF stays for ranking only.
- **KD6 — Add the missing "about-our-work" decision** (Self-RAG adaptive-retrieve pattern) — the structural gap that lets adjacent chatter through.
- **KD7 — Over-refusal is a guardrail metric on every step.** Research: vanilla RAG over-refuses up to ~35.5% on all-irrelevant context; tightening can backfire.
- **KD8 — Post-meeting Sonnet re-pass is a separate deferred track**, not part of the 1-by-1 real-time sequence.

## Acceptance Examples

- **AE1 (bucket 1 — off-topic).** "Did anyone catch the game last night?" → no card. The relevance gate skips it; nothing is retrieved or synthesized.
- **AE2 (bucket 2 — adjacent, not ours).** "What's the best way to handle CORS errors in a React app?" (generic, not about our code) → no card, *even if* retrieval finds a tangential doc. The about-our-work decision suppresses it.
- **AE3 (bucket 2 — the leak we see today).** Chit-chat mentioning "remote" while the corpus has an unrelated "remote debugging" doc → must **not** answer from the unrelated doc.
- **AE4 (bucket 3 — relevant).** "How is the corpus searched at query time?" → surfaces a grounded card citing the corpus-search code (hybrid dense + BM25 fused with RRF). (Matches an existing golden question.)
- **AE5 (recall guardrail).** A tightened gate must not suppress AE4-class questions — over-refusal on bucket 3 stays within the ≤~2–3 pt guardrail across every change.

## Scope Boundaries

### In scope
- The **synthetic three-bucket eval set** + harness extension to run the full path and report precision / over-refusal / latency.
- **Quick wins**, each landed and eval-gated one at a time: the relevance judge gains an "about-our-work" + question/task decision and stops failing open; remove the 80-char heuristic auto-pass; absolute per-card relevance grading for the gate; soften the "answer even tangentially" synthesis bar with first-class abstention; raise the RRF floors behind a flag as a stopgap.
- **Larger additions**, eval-gated: strip-level refinement of retrieved cards (drop off-task strips inside adjacent hits); a pre-retrieval "should-we-act" gate; a calibrated reranker.

### Deferred for later
- The **strict post-meeting re-pass** (Sonnet) that re-grades cards/syntheses for the durable Captures/recap view — the "after the fact" tier, a separate track.
- The **cross-encoder reranker** is conditional: pursue only if prompt-only absolute grading proves insufficient on the eval set (decide from the numbers).

### Outside this product's identity
- Re-litigating the **skill-vs-RAG boundary** — stays as-is.
- **Skill-argument misparse self-healing** — a different problem ([[skills-rag-robustness]], `docs/brainstorms/2026-06-02-skills-rag-robustness-requirements.md`); shares only the synthesis-honesty prompt.
- Changing **corpus contents or indexing** — this effort tunes what surfaces, not what's indexed.

## Success Criteria

- Measurable **precision increase** on the labeled set, with over-refusal within the guardrail and latency within budget.
- The **adjacent hard-negative class (bucket 2) stops leaking** — the cards a glancing user sees are about our work.
- Every change carries a **recorded before/after eval** (regression coverage); no real-question regressions ship.
- The eval set + metrics are durable and re-runnable from `/debug/eval`, so future pipeline changes inherit the guardrail.

## Open Questions / Assumptions (resolve at planning)

- **Absolute-grade mechanism** — prompt-only Haiku judge vs. a cross-encoder reranker. Research *refuted* a universal cross-encoder threshold, so a reranker must be calibrated per-corpus. (Technical decision → /ce-plan.)
- **"About-our-work" gate placement** — pre-retrieval (short-circuit before embedding), post-retrieval (CRAG Incorrect → abstain), or both. (Technical decision → /ce-plan.)
- **Exact numeric thresholds** — final precision target, the over-refusal tolerance number (assume ≤~2–3 pts), and the latency budget figure (assume the existing ~3s real-time window) to gate against.
- **Harness prerequisite** — extending the eval to invoke the full gate is likely a shared prerequisite unit before any tuning step; confirm at planning.
- **Synthetic-data construction** — how bucket-2 "adjacent" negatives are generated to be genuinely hard (topically near our corpus but not answerable), and whether generation is LLM-assisted + human-reviewed.

## Sources & Context

- **Research study (this session)** — verified: CRAG absolute confidence grading + decompose-recompose ([arXiv 2401.15884](https://arxiv.org/pdf/2401.15884)); Self-RAG adaptive retrieve + ISREL/ISSUP ([arXiv 2310.11511](https://arxiv.org/abs/2310.11511)); over-refusal up to 35.5% ([arXiv 2509.01476](https://arxiv.org/html/2509.01476v2)); bi-encoder/RRF scores query-dependent (Elastic); relevance-only optimization can degrade answers ([arXiv 2504.07104](https://arxiv.org/pdf/2504.07104)). Refuted (do not assume): universal cross-encoder threshold; multi-criteria rerankers; "one positive doc eliminates over-refusal."
- **Pipeline (verified map)** — `packages/engine/src/relevance/{heuristic,prompt,anthropic-classifier,contract}.ts`; `apps/daemon/src/retrieve/pipeline.ts`; `apps/daemon/src/corpus/query.ts`; `packages/engine/src/synthesize/prompt.ts`.
- **Eval harness (already exists)** — `apps/bot-worker/eval/golden-questions.jsonl` (65 items); `apps/bot-worker/src/corpus-eval.ts` (supports `must_surface`, `expect_answer_contains`, `expect_refusal`); `apps/bot-worker/src/debug/eval-routes.ts`; the `/debug/eval` page.
- **Prior art** — `docs/architecture/retrieval-pipeline.md`; `docs/brainstorms/2026-06-01-corpus-retrieval-improvements-requirements.md`; `docs/plans/2026-06-01-002-feat-corpus-retrieval-claude-augmented-rag-plan.md`.
