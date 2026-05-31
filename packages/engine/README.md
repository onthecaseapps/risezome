# @risezome/engine

Shared engine code used by both the legacy local daemon (`apps/daemon/`) and
the cloud surfaces (`apps/portal/` Inngest functions and `apps/bot-worker/`).
Lifted from `apps/daemon/src/` so the two surfaces don't drift.

## Layout

```
src/
├── chunker/      # text + code chunking (lifted in U5b)
├── embed/        # Voyage embedder + cache + contract (lifted in U5b)
├── skills/       # registry + GitHub skills (lifted in U5b)
├── transcribe/   # transcript provider contract (lifted in U5b)
└── types.ts      # canonical types (CanonicalDoc, CanonicalChunk, ...)
```

## Storage abstraction

This package defines **interfaces** for `TranscriptStore`, `CorpusReader`,
and `MeetingSessionStore` (added later in U9–U10). The daemon implements
them against SQLite; the bot-worker implements them against Postgres. The
shared pipeline classes (retrieval, synthesis) take these interfaces as
constructor params — no SQLite or Postgres types leak into the engine
itself.

## What this package does NOT do

- No process-management code (lives in the consumer: daemon CLI, Inngest
  function, bot-worker server).
- No HTTP server.
- No model-provider keys or env loading — consumers pass keys explicitly.
