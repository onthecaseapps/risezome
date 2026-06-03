# Data sub-processors

Risezome processes customer data (source code, documentation, meeting
transcripts) primarily inside our own infrastructure (the portal, the
bot-worker, and our Supabase/Postgres database). To deliver retrieval and
synthesis, a bounded set of that content is sent to two external AI providers —
our **data sub-processors**. This document discloses what leaves our trust
boundary, to whom, and under what terms.

Last reviewed: 2026-06-03.

## Sub-processors

| Sub-processor | Purpose | Data sent | Where in code |
| --- | --- | --- | --- |
| **Voyage AI** | Text embeddings for vector search (indexing + per-utterance query embedding) | Chunked source code / document text (with an LLM-generated context prefix) at index time; meeting query text at retrieval time | `packages/engine/src/embed/voyage.ts` (`POST https://api.voyageai.com/v1/embeddings`); driven by `apps/portal/src/inngest/lib/connector-index.ts` and the bot-worker retrieval path |
| **Anthropic (Claude API)** | Contextualization, document summarization, answer synthesis, relevance/routing classification | Document text + transcript context windows; the question being answered | `packages/engine/src/synthesize/*`, `packages/engine/src/summarize/*`, contextualize/relevance/router call sites |

No other third party receives customer content. Connected sources (GitHub,
Jira/Confluence, Trello) are **data origins** the customer authorizes, not
sub-processors we send their data to.

## Data-handling terms

- **Zero retention / no training.** Both providers offer enterprise terms under
  which prompt/input data is **not retained** beyond the request and is **not
  used to train models**. Confirm these terms are contractually in place (DPA /
  enterprise agreement) before GA and record the agreement reference here.
- **Transport.** All egress is over TLS (HTTPS) to the providers' published API
  endpoints.
- **Credentials.** Provider API keys live in server-side environment variables
  only (never in the database, never logged).

## Scope and controls

- Only content the customer connected for retrieval is embedded/synthesized;
  see the RLS isolation and content-protection controls in
  [`/SECURITY.md`](../../SECURITY.md).
- **Deferred:** a per-organization egress opt-out (and/or a self-hosted
  embedding tier) for customers who cannot send proprietary code to a third
  party. Tracked as follow-up, not yet implemented.

## Updating this document

When a new external service begins receiving customer content (a new embedding
provider, a reranker API, an LLM, an OCR/transcription service, etc.), add it to
the table above **before** the egress ships, and re-confirm the retention terms.
