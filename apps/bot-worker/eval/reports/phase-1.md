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
   `mode: 'full'` for each `sources` row. Confirm chunks now carry
   `context` (spot-check `doc_chunks.context is not null`).
3. **Enable reranking** (`RISEZOME_RERANK_ENABLED=true`) on the bot-worker.
4. **Phase-1 run:**
   ```bash
   pnpm tsx --env-file=.env eval/replay.ts <orgId> --metrics > eval/reports/phase-1-run.json
   ```
5. Record the delta below and commit this file.

## Results (fill in)

| Metric | Baseline | Phase 1 | Δ |
|---|---|---|---|
| Pass rate | | | |
| Mean recall (must-surface) | | | |
| RAGAS faithfulness | | | |
| RAGAS answer-relevancy | | | |
| RAGAS context-precision | | | |
| RAGAS context-recall | | | |
| Anchor "what AI models" | FAIL (expected) | | |

## Go / No-Go

Phase 1 passes if context recall and the anchor question improve materially
with no faithfulness regression. If the anchor still fails after reindex +
rerank, the answer-bearing chunks aren't being surfaced/consolidated →
proceed to Phase 2 (summaries + routing) which targets exactly that.
