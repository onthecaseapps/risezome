---
title: "spike: LazyGraphRAG — build or skip (deferred decision)"
type: spike
status: deferred
date: 2026-06-01
origin: docs/plans/2026-06-01-002-feat-corpus-retrieval-claude-augmented-rag-plan.md
---

# LazyGraphRAG Evaluation Spike (U11)

## Decision this spike must produce

**Build a LazyGraphRAG-style entity/co-occurrence layer for thematic,
corpus-wide questions, or skip it?** Output is a one-line recommendation
(build / skip) plus the eval evidence behind it — **not** production code.

This is **deferred by design**: it only earns evaluation *after* Phases 0–3
are deployed and measured. Full Microsoft GraphRAG remains explicitly out of
scope (indexing + query cost too high for a real-time assistant); the only
candidate is **LazyGraphRAG** (near-zero indexing, query-time summarization).

## Gating condition (do not start until all true)

- Phase 0 eval harness is in use (`apps/bot-worker/eval/`).
- Phase 1 (contextual retrieval + reranking) reindexed + measured
  (`apps/bot-worker/eval/reports/phase-1.md`).
- Phase 2 (summaries + routing) and Phase 3 (CRAG + adaptive routing)
  deployed + measured.

## What to measure

Add a small set of **thematic / corpus-wide** golden questions — the class
LazyGraphRAG targets, distinct from the point-lookup questions in the
existing set. Examples:

- "What architectural patterns recur across the codebase?"
- "What are all the external services this project depends on?"
- "What are the main themes in the open issues?"

Run them through the post-Phase-3 pipeline (contextual retrieval + rerank +
summaries + routing + CRAG) and record RAGAS context-recall + answer
relevancy. These are the baseline LazyGraphRAG would have to beat.

## Decision criteria

- **Skip** if the post-Phase-3 stack already answers thematic questions
  acceptably (summaries + routing were specifically meant to help here). The
  default expectation is skip — the cheaper layers likely suffice.
- **Build** only if there is a *material, repeated* gap on thematic questions
  that summaries/routing don't close, AND the gap matters to real meeting
  usage (not just the eval set). If so, write a follow-up implementation plan
  scoped to LazyGraphRAG's NLP co-occurrence graph (no LLM entity extraction
  at index time) with a query-time budget that fits the live path.

## Notes / prior art

- Microsoft LazyGraphRAG: near-vector-RAG indexing cost, query-time
  summarization, ~700x lower query cost than full GraphRAG Global Search.
  https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/
- Constraint: must not regress the real-time live path; any graph build is
  index-time only, and query-time graph traversal must stay within the
  existing fast-cards-then-synthesis budget.
