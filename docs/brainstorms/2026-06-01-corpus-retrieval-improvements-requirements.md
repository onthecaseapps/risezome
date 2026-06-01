---
title: "Corpus retrieval & synthesis improvements (Claude-augmented RAG)"
type: requirements
status: draft
date: 2026-06-01
---

# Corpus Retrieval & Synthesis Improvements

## Problem

Risezome answers meeting questions by retrieving from a per-org corpus
(`docs` / `doc_chunks` / `corpus_chunk_embeddings`) indexed from the
customer's connected sources (GitHub repos/issues/PRs, Trello, Jira,
Confluence). The retrieval layer is **chunk → Voyage embeddings → hybrid
search (pgvector cosine + Postgres FTS fused with RRF) → Claude Haiku
synthesis with inline citations** (`apps/bot-worker/src/corpus-search.ts`,
`apps/bot-worker/src/retrieval.ts`, `packages/engine/src/synthesize/`).

The synthesis layer is now correct (grounded-or-nothing, citation
verification, fabrication eliminated — see
`packages/engine/src/synthesize/prompt.ts`). The remaining gap is
**retrieval quality**: the corpus often can't answer real questions about
the customer's data because the answer is **scattered** and no single chunk
consolidates it.

**Observed failure (this is the anchor case):** "what AI models are used in
the project" returns an honest refusal. The model stack is mentioned across
many files (`Deepgram` in one, `Voyage` in another, `Claude Haiku` in a
third), but no chunk states it together, and the query keyword "models"
isn't dense in the answer-bearing chunks. Keyword-dense noise (the
*summarizer's* prompt file, a `*.test.ts`) outranks the real mentions. The
information exists in the corpus; retrieval just can't assemble it.

This is a recall + assembly problem, not a synthesis bug.

## Goal

Make the corpus reliably answer questions about a customer's connected data
— including questions whose answer is scattered across multiple sources —
with grounded, cited answers, while keeping the live meeting path fast.
Move from "basic vector encoding" to a **Claude-augmented retrieval
pipeline** where expensive intelligence runs at index time and the live
path stays light, with a cheap on-miss fallback.

## Success Criteria

- A **golden-question eval set** (~30–50 real questions about a seeded
  corpus, including the known failures) plus **RAGAS metrics**
  (context recall, context precision, faithfulness, answer relevancy)
  exists and is re-runnable after each phase.
- The known-failure queries (e.g., "what AI models are used") return a
  **grounded, cited answer** rather than a refusal, with the answer-bearing
  sources actually surfaced.
- Each phase shows a **measurable** lift on the eval set (primarily context
  recall in early phases, faithfulness/answer-relevancy throughout) and
  ships independently.
- The live meeting path's added latency stays within the existing
  fast-cards-then-streamed-synthesis budget (heavy work is index-time; the
  only new live cost is the reranker, in the already-async synthesis slot,
  plus an on-miss fallback that pays cost only when retrieval is weak).

## Actors & Context

- **Meeting participant (end user)** — asks/implies questions during a live
  meeting; sees cards + a synthesized, cited answer on the live page.
- **Indexing pipeline** — per-source Inngest functions in
  `apps/portal/src/inngest/functions/` (index-repo, index-github-issues,
  index-trello, index-jira, index-confluence) writing the corpus. Heavy
  index-time enrichment lands here.
- **Bot-worker retrieval/synthesis** — `apps/bot-worker` reads the corpus
  live. Query-time changes land here.

Pre-launch: corpus reindexes and breaking corpus-schema changes are
acceptable.

## Approach: phased, ROI-ordered roadmap

Each phase is independently shippable and measured against the Phase 0
eval. Research basis: Anthropic Contextual Retrieval, Voyage rerank-2.5,
LlamaIndex document-summary index, Corrective RAG (CRAG), Adaptive RAG,
RAGAS (see References).

### Phase 0 — Eval baseline (measure before changing)

- **R0.1** Curate a golden set (`eval/` or `docs/`-adjacent) of ~30–50
  questions about a representative seeded corpus, each labeled with the
  docs/chunks that *should* surface and what a correct answer must contain
  (e.g., "what AI models are used" → must surface README/architecture
  chunks; answer must contain Haiku / Voyage / Deepgram).
- **R0.2** Build a replay runner that pushes each question through the live
  retrieval + synthesis path and records: which chunks surfaced (hit-rate
  on the labeled set), and the synthesized answer / refusal.
- **R0.3** Add **RAGAS** LLM-judge metrics (context recall, context
  precision, faithfulness, answer relevancy) — no ground-truth answers
  required. Establish the current baseline so every later phase is
  quantified.
- Open question: RAGAS is Python; decide integration shape (standalone
  Python eval script/service vs. reimplementing the four metrics as a small
  TS LLM-judge). See Open Questions.

### Phase 1 — Index-time enrichment (highest ROI)

- **R1.1 Contextual Retrieval.** At index time, for each chunk, call Claude
  Haiku with the full source document in a prompt-cached block and have it
  write a 50–100 token context situating the chunk ("This is from the
  bot-worker transcription module; it configures Deepgram…"). Prepend that
  context to the chunk text **before** embedding and before the FTS
  `text_fts` column is generated. Process document-by-document to maximize
  cache hits. (Anthropic: 49% retrieval-failure reduction for contextual
  embeddings + contextual BM25; ~$1–3 / 1M tokens one-time with caching.)
  This directly attacks the scattered/keyword-mismatch failure.
- **R1.2 Reranker.** Add a cross-encoder rerank stage to `corpus-search.ts`:
  retrieve a larger candidate pool (~50 vector + ~50 FTS), rerank with
  Voyage rerank-2.5 (32K context; instruction-steerable, e.g. "prefer
  application code and docs over tests"), keep top-K. (~600ms, ~$0.05/1M
  tokens; runs in the already-async synthesis slot. Anthropic: contextual +
  rerank = 67% failure reduction.)

### Phase 2 — Summaries & routing

- **R2.1 Per-source summary docs.** At index time, have Claude write a
  concise summary per source document (and optionally per repo/board/space)
  — the user's "memory file" idea. Index these summaries as first-class
  corpus docs so a high-level question can hit a consolidating summary
  instead of needing to assemble scattered chunks.
- **R2.2 Routing manifest.** Build a document-summary index (one embedding
  per source doc/summary) used to **pre-route** a query to the relevant
  source subset before chunk-level retrieval — prunes cross-source noise
  (GitHub vs Jira vs Confluence vs tests). This is the user's "for this kind
  of question, these are the files" idea, in its lightweight form.
- **R2.3 Parent-document retrieval.** Embed precise child chunks but return
  the parent section/document when a child scores high, so scattered facts
  arrive with surrounding context for synthesis.

### Phase 3 — On-miss intelligence (cheap, gated)

- **R3.1 CRAG-style fallback.** When retrieval is weak (below the relevance
  floor / no confident hit), instead of refusing immediately, ask Claude to
  **expand the query with candidate keywords** ("what AI models are used" →
  also try Gemini, Claude, Haiku, GPT/OpenAI, Voyage, Deepgram, embeddings,
  transcription) and re-retrieve once. Cap iterations (≤2) to bound latency.
  This is the user's fallback-augmentation idea.
- **R3.2 Adaptive routing.** A fast (<50ms) query classifier decides the
  path: simple/lookup queries take single-shot retrieval; scattered/thematic
  queries take the richer path (multi-query fan-out and/or the R3.1
  fallback). Keeps the common case fast and only spends on hard queries.

### Phase 4 — Deferred / evaluate

- **R4.1 LazyGraphRAG (evaluate only after Phases 0–3).** Near-zero-indexing
  entity/co-occurrence graph for thematic, corpus-wide questions ("what
  architectural patterns do we use across the repo?"). Evaluate marginal
  benefit over contextual retrieval + reranking before committing; full
  Microsoft GraphRAG is explicitly out (see Boundaries).

## Cross-cutting: corpus curation

The "test file ranked #2" noise and the "synthesizer's own prompt file as a
source" oddity are real. Decision: **prefer to fix these with relevance
(contextual retrieval makes real chunks findable; the reranker can be
instructed to deprioritize tests/fixtures; the routing manifest prunes
source types) rather than hard path exclusions** — the user wants the corpus
to be able to surface and cite anything it contains. Revisit explicit
index-time exclusions only if reranking + routing don't sufficiently
suppress noise on the eval set.

## Scope Boundaries

**In scope**
- Index-time enrichment (contextual retrieval, per-source summaries,
  routing manifest), reranking, on-miss query augmentation, adaptive
  routing, and the eval harness.
- Changes to the Inngest indexers, `corpus-search.ts`, the synthesis
  context, and the corpus schema as needed.

**Out of scope / deferred**
- **Full Microsoft GraphRAG** — indexing + query cost too high for a
  real-time assistant. (LazyGraphRAG only as a Phase 4 evaluation.)
- **Replacing the stack** — stay on pgvector + Voyage + Claude; no new
  vector database or embedding/LLM vendor.
- **HyDE** — high latency, diminishing returns once contextual retrieval is
  applied.
- Heavy per-query agentic loops (3+ reflection iterations) — incompatible
  with the real-time path; capped CRAG (≤2) only.

## Dependencies & Assumptions

- **Reindex required** for Phase 1/2 (contextual context + summaries are
  baked at index time). Pre-launch, so acceptable; the existing
  reconciliation/reindex path (`corpus-reconcile`) is the mechanism.
- **Voyage rerank-2.5** API access (we already use Voyage for embeddings).
- **Prompt caching** on the contextualization calls to keep index cost low.
- **RAGAS** is Python-based — integration shape is an open question (below).
- Assumes index-time Claude cost (~$1–3 / 1M tokens with caching) is
  acceptable at current corpus sizes; revisit for very large customer repos.

## Open Questions

1. **RAGAS integration in a TS monorepo** — standalone Python eval
   script/service, or reimplement the four metrics as a small TS LLM-judge?
   (Affects Phase 0 shape.)
2. **Reranker live-latency budget** — is ~600ms in the synthesis slot
   acceptable, or do we need rerank-2.5-lite / a smaller candidate pool?
3. **Summary granularity** (R2.1) — per-document only, or also
   per-repo/board/space roll-ups? Trade-off: more consolidation vs more
   index cost + staleness.
4. **Reindex trigger for enrichment** — backfill all existing corpora once,
   or only enrich on the next reconcile per source?
5. **How aggressively to route/prune** (R2.2) — a wrong route hides the
   answer; needs an eval-driven safety margin (always fall back to
   all-source retrieval on low routing confidence?).

## References

- Anthropic — Introducing Contextual Retrieval:
  https://www.anthropic.com/news/contextual-retrieval
- Claude Cookbook — Contextual Embeddings guide:
  https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide
- Voyage rerank-2.5: https://blog.voyageai.com/2025/08/11/rerank-2-5/
- RAPTOR (recursive summary trees): https://arxiv.org/abs/2401.18059
- Dense X / proposition indexing: https://arxiv.org/abs/2312.06648
- Agentic RAG survey (CRAG / Adaptive / Self-RAG): https://arxiv.org/abs/2501.09136
- Microsoft LazyGraphRAG:
  https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/
- RAGAS: https://arxiv.org/abs/2309.15217
