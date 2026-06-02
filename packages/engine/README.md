# @risezome/engine

Shared engine code used by both the legacy local daemon (`apps/daemon/`) and
the cloud surfaces (`apps/portal/` Inngest functions and `apps/bot-worker/`).
Lifted from `apps/daemon/src/` so the two surfaces don't drift.

## Layout

```
src/
├── chunker/        # text + code chunking (used by the indexers)
├── contextualize/  # Contextual Retrieval: per-chunk situating context (Anthropic)
├── summarize-doc/  # per-document fact-dense summary → is_summary chunk (Anthropic)
├── embed/          # Voyage embedder + cache + contract + rerank-2.5 client
├── query-expand/   # CRAG on-miss query expansion (Anthropic term expansion)
├── query-route/    # query-complexity routing (gates CRAG expansion)
├── parent-doc/     # child→parent expansion strategy (whole-doc or window)
├── synthesize/     # Anthropic synthesizer + citation parsing/verification + prompt
├── relevance/      # heuristic-gated LLM relevance classifier (skip filler)
├── router/         # tool-vs-RAG router classifier (heuristic + Anthropic)
├── skills/         # self-healing skill contract (SkillResult.recovery) + registry
├── summarize/      # rolling-window meeting summarizer (Anthropic)
├── eval/           # RAGAS-style metrics + LLM judge for the eval harness
├── transcribe/     # transcript provider contract (used by the legacy daemon)
└── types.ts        # canonical types (CanonicalDoc, CanonicalChunk, ...)
```

Each directory is a separate package export (e.g. `@risezome/engine/chunker`,
`@risezome/engine/router`). How these compose into the live index-time and
query-time pipeline is documented in
[`docs/architecture/retrieval-pipeline.md`](../../docs/architecture/retrieval-pipeline.md).

## Stateless by design

The engine holds no storage. Consumers own persistence and pass what each
function needs explicitly: the bot-worker passes a Supabase client into the
skill `SkillContext`; the Inngest indexers call the chunker + embedder and
write to Postgres themselves; the legacy daemon does the same against SQLite.
No SQLite or Postgres types leak into the engine.

## What this package does NOT do

- No process-management code (lives in the consumer: daemon CLI, Inngest
  function, bot-worker server).
- No HTTP server.
- No model-provider keys or env loading — consumers pass keys explicitly.
