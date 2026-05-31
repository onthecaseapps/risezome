# @risezome/engine

Shared engine code used by both the legacy local daemon (`apps/daemon/`) and
the cloud surfaces (`apps/portal/` Inngest functions and `apps/bot-worker/`).
Lifted from `apps/daemon/src/` so the two surfaces don't drift.

## Layout

```
src/
├── chunker/      # text + code chunking (used by the indexers)
├── embed/        # Voyage embedder + cache + contract
├── synthesize/   # Anthropic synthesizer + citation parsing + prompt
├── relevance/    # heuristic-gated LLM relevance classifier (skip filler)
├── router/       # tool-vs-RAG router classifier (heuristic + Anthropic)
├── skills/       # skill contract (SkillContext/SkillResult) + registry
├── summarize/    # rolling-window summarizer (Anthropic)
├── transcribe/   # transcript provider contract (used by the legacy daemon)
└── types.ts      # canonical types (CanonicalDoc, CanonicalChunk, ...)
```

Each directory is a separate package export (e.g. `@risezome/engine/chunker`,
`@risezome/engine/router`).

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
