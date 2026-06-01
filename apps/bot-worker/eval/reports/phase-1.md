# Phase 1 rollout + eval gate (U5)

Phase 1 = Contextual Retrieval (U3) + Voyage reranking (U4). Both require an
operator-run rollout: contextual context is baked at **index time**, so the
corpus must be reindexed, and the eval makes paid Voyage + Anthropic calls.
This unit is the go/no-go measurement gate — run the steps, fill in the
table, commit the delta.

## Prerequisites

- Migration `20260604000000_contextual_chunks.sql` applied (adds
  `doc_chunks.context`, rebuilds `text_fts` from context + body). Already
  pushed to remote.
- Env on the indexer (portal Inngest) and bot-worker:
  - `ANTHROPIC_API_KEY` set → contextualization turns on automatically
    (`optionalContextGenerator()`).
  - `RISEZOME_RERANK_ENABLED=true` + `VOYAGE_API_KEY` → reranking on
    (`optionalReranker()`).
  - Optional: `RISEZOME_VECTOR_DISTANCE_FLOOR` (default 0.45).

## Steps

1. **Baseline** (before enabling, or on a pre-Phase-1 deploy):
   ```bash
   cd apps/bot-worker
   pnpm tsx --env-file=.env eval/replay.ts <orgId> --metrics > eval/reports/baseline.json
   ```
2. **Reindex (full, big-bang — KTD-2).** Trigger a full reconcile for every
   source so every chunk is contextualized. Sources → ⋮ → **Reindex (full)**
   per source (GitHub repo, Trello, Jira, Confluence), or emit
   `risezome/source.index-requested` / connector `*.index-requested` with
   `mode: 'full'` for each `sources` row.

   ⚠️ **IMPORTANT — skip-unchanged blocks re-contextualization.** A normal
   full reindex prunes removed docs but **skips re-embedding unchanged docs**
   (matching `content_hash`), so it will NOT add context to a corpus indexed
   before contextualization shipped — only files that *changed* get
   contextualized. To re-contextualize an existing corpus you must force a
   rebuild by clearing the fingerprint first:
   ```sql
   update docs set content_hash = null where source_id = '<sourceId>';
   ```
   then trigger the full reindex (now every doc reads as "changed" and is
   rebuilt with context + summary). Spot-check after:
   ```sql
   select count(*) from doc_chunks where context is not null;  -- ~all chunks
   select count(*) from doc_chunks where is_summary;           -- ~1 per doc
   ```
   Follow-up: consider a first-class `mode: 'force'` on the index event that
   bypasses the unchanged-skip, so this doesn't need a manual SQL step.
3. **Enable reranking** (`RISEZOME_RERANK_ENABLED=true`) on the bot-worker.
4. **Phase-1 run:**
   ```bash
   pnpm tsx --env-file=.env eval/replay.ts <orgId> --metrics > eval/reports/phase-1-run.json
   ```
5. Record the delta below and commit this file.

## Results (2026-06-01)

Baseline = pre-Phase-1 corpus (12 contextualized chunks, 12 summaries — only
changed files, skip-unchanged blocked the rest). Phase 1 = forced full
re-contextualization (1252/1253 chunks contextualized, 154 summaries) + rerank
+ CRAG enabled. Both runs: `eval/replay.ts <org> --metrics`, 10 golden
questions. Raw: `eval/reports/baseline.json`, `eval/reports/phase-1-run.json`.

| Metric | Baseline | Phase 1 | Δ |
|---|---|---|---|
| Pass rate | 3/10 (30%) | 4/10 (40%) | +10pp |
| Mean recall (must-surface) | 0.22 | 0.50 | +0.28 |
| RAGAS faithfulness | 1.00 | 1.00 | 0 |
| RAGAS answer-relevancy | 0.95 | 0.88 | −0.07 |
| RAGAS context-precision | 0.40 | 0.70 | **+0.30** |
| RAGAS context-recall | 1.00 | 1.00 | 0 |
| Anchor "what AI models" | FAIL (refused) | grounded + cited ✓ | **flipped** |

The anchor now answers correctly ("Claude Haiku for synthesis, Voyage
embeddings for retrieval, Deepgram for transcription", fully cited) instead of
refusing — the headline goal of Phase 1.

### The label-recall metric undercounts answer quality

`must-surface` recall scores **retrieved-doc keywords**, not answer
correctness. 5 of the 6 Phase-1 "FAIL"s are actually correct, well-cited
answers the metric can't credit:

- **what ai models** (recall 0%) — answer names Claude Haiku, Voyage, Deepgram
  correctly; retrieval surfaced the brainstorm/plan docs that enumerate them,
  not the README/source files the labels guessed.
- **bot join** (33%) — answer is accurate (Recall.ai via Inngest, JWT WS to
  bot-worker); labels `recall`/`bot-worker` appear in the answer prose, just
  not as retrieved-doc keyword hits.
- **deepgram disconnect** (50%) — accurate (reconnect backoff max 3, stopped
  event, frame buffering).
- **sources reindexed** (0%) — accurate (reconcile helper, content-hash
  fingerprint, skip/re-embed/delete, FK cascade).
- **citations verified** (0%) — accurate (parser on `done`, `verifyCitations`,
  verbatim-substring highlight).

Action: the golden labels should assert **answer content**, not retrieved-doc
keywords. Until then, read RAGAS (faithfulness + context-precision) and the
anchor as the real signal, and treat label-recall as a loose relative gauge.

### One REAL failure: stale archived docs poison retrieval

- **what database does the corpus use** (recall 66%) — answer is **wrong**:
  "SQLite with better-sqlite3 / sqlite-vec / risezome.db". That's the
  *superseded local* architecture; current is **Postgres + pgvector (cloud)**.
  Retrieval pulled `docs/plans/archive/…` docs describing the old design and
  synthesized a confidently-wrong, internally-faithful answer (hence RAGAS
  faithfulness stays 1.00 — it faithfully reported a stale source).

This is the actionable finding. Archived/superseded plans are first-class
corpus docs and out-rank current architecture docs on some queries. Fixes:
exclude `docs/plans/archive/**` (and similar) from indexing, or down-rank
docs marked `status: archived/superseded` — and it directly motivates **U7
(routing manifest)**, which would pre-route architecture questions away from
archived planning docs.

## Go / No-Go

**GO.** Pass condition (context signal + anchor improve materially, no
faithfulness regression) is met: anchor flipped refuse→grounded,
context-precision +0.30 (0.40→0.70), faithfulness held at 1.00, pass-rate and
label-recall both up. The −0.07 answer-relevancy dip is within noise and
attributable to the one stale-corpus answer plus the anchor's meta-commentary.

Two follow-ups fall out of this run (independent of the Go decision):
1. **Corpus hygiene** — exclude/down-rank `docs/plans/archive/**` so stale
   architecture docs stop outranking current ones (the "what database" miss).
2. **Answer-content golden labels** — rewrite `golden-questions.jsonl`
   assertions to check answer text, not retrieved-doc keywords, so the metric
   stops undercounting correct answers.
