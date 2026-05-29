---
title: "feat: Router + per-integration skills framework (v1)"
type: feat
status: active
date: 2026-05-29
origin: docs/brainstorms/router-skills-framework-requirements.md
---

# Router + Per-Integration Skills Framework (v1)

## Overview

Add a second answer path next to RAG: a heuristic-gated Claude classifier that picks a typed read-only skill from a per-connector registry, executes the skill against the local corpus, and feeds the result into the existing synthesizer as a numbered source. v1 ships GitHub-only with four skills (`count`, `list`, `recently_updated`, `by_author`). Failure of any tool-path step falls back silently to RAG synthesis. The user sees one answer surface (the existing AI SUMMARY card); the framework is what changes.

---

## Problem Frame

Aggregation, filter, and count questions ("how many open issues", "list all PRs by jamie", "what was updated this week") are constitutionally unanswerable via top-K retrieval. RAG pulls the most relevant chunks, not all matching ones, so the synthesizer either refuses or hallucinates a count from a sample of three. The corpus already has the data — `docs.type`, `docs.authors`, `docs.updated_at`, plus chunk text containing `Status: open` and `Labels: …` after the A-E chunker fix. What's missing is a path that queries that structured data directly.

A heuristic regex first triggers the classifier only on utterances whose shape suggests an aggregation/list/filter question (~10-20% of utterances), so the common case pays zero added cost or latency. When triggered, the classifier and retrieval run in parallel, and the synthesizer waits on both before rendering — so the user sees raw cards no later than today.

See origin: `docs/brainstorms/router-skills-framework-requirements.md`.

---

## Requirements Trace

- **R1** — Aggregation queries return correct, deterministic answers (origin Success Criterion #1)
- **R2** — Non-tool utterances pay zero added latency and zero extra LLM cost (origin Success Criterion #2)
- **R3** — Tool-suspected utterances add at most `max(classifier_latency, retrieval_latency)` to TTFT, not their sum (origin Success Criterion #3)
- **R4** — Classifier and skill failures fall through to RAG silently; never user-visible (origin Success Criterion #4, origin D6)
- **R5** — Cost per typical 30-minute meeting stays ≤$0.05 (origin Success Criterion #5, ~$0.005 above today's baseline)
- **R6** — Adding a new skill or a new connector's skill set requires no changes to the router (origin Success Criterion #6)
- **R7** — Tool result renders in the existing AI SUMMARY card as a numbered source the synthesizer cites in natural language (origin D2)
- **R8** — v1 is strictly read-only; no skill mutates state, calls live APIs that mutate state, or sends messages (origin D1, "Outside this product's identity")
- **R9** — Heuristic-gated trigger model: classifier only runs when a regex flags the utterance as tool-shaped (origin D3)
- **R10** — Reuses the existing `anthropic` consent grant; no per-skill or per-connector consent (origin D7)

---

## Scope Boundaries

- No additional connectors' skill sets (Jira, Confluence, Slack, etc.) — separate PRs once their connectors exist
- No skill-chaining or multi-step agent loops — classifier picks one skill per utterance, single shot
- No live API calls inside skills — v1 skills only query the local SQLite corpus
- No transcript-enhancement / HyDE rewrite on every utterance — the classifier's optional rewritten-query output is plumbed but the always-run-classifier mode is deferred
- No new consent surface — anthropic grant covers both synthesizer and classifier
- No write-capable skills, ever, for v1 or follow-up under this plan

### Deferred to Follow-Up Work

- Skill-set for the second connector (Jira when its connector lands, or Confluence): separate plan once a second consumer of the registry exists
- Schema change to add `docs.state` column for cleaner skill SQL: separate refactor + reindex; v1 uses FTS5 search on `doc_chunks.text` for `Status: open` etc.
- Always-on classifier mode (transcript enhancement on every utterance): separate brainstorm + plan after dogfood data shows whether always-run is justified
- Native Anthropic tool execution (where Claude actually runs the tool inside the same call): out of scope; v1 uses tool_use only as a structured-output mechanism for the classifier — execution happens server-side in our code

---

## Context & Research

### Relevant Code and Patterns

- **Synthesizer streaming Anthropic client** (just shipped): `apps/daemon/src/synthesize/anthropic.ts` — provides constructor shape, fetchImpl injection, retry/backoff with Retry-After, abort handling. The classifier client mirrors this exactly, with `tool_use` request shape and non-streaming response.
- **Cacheable prompt prefix**: `apps/daemon/src/synthesize/prompt.ts` — system block + few-shots + `cache_control: ephemeral` on the last block. Classifier prompt follows the same pattern; ~4096-token Haiku cacheable-prefix constraint applies the same way.
- **Pipeline integration seam**: `apps/daemon/src/retrieve/pipeline.ts` `RetrievalPipeline.#evaluate()` — the router gate lives at the top of `#evaluate` before embedding; the parallel branch joins before `#maybeSynthesize` is called.
- **Hybrid search infra**: `apps/daemon/src/corpus/query.ts` already exposes `hybridSearch(db, text, vector, ...)`. The skill SQL goes through the same db handle; no new connection management.
- **FTS5 index on chunks**: the `fts_doc_chunks` virtual table is already migrated. Skill SQL queries `WHERE text MATCH '"Status: open"'` use the existing FTS5 index. No schema migration needed.
- **Connector contract**: `apps/daemon/src/connectors/contract.ts` — currently `Connector = { source, scope, pull }`. Skills are a *new* surface alongside, not a modification — connector modules export a `skills: Skill[]` array.
- **Consent runtime gate**: `apps/daemon/src/cli/consent-store.ts` `hasConsent(db, 'anthropic')`. Classifier instantiation uses the same closure pattern as the synthesizer.
- **Test patterns**:
  - HTTP mocking via `fetchImpl` injection: `apps/daemon/test/embed/voyage.test.ts`
  - Pipeline tests with fake synthesizer: `apps/daemon/test/retrieve/pipeline.test.ts` — the `fakeSynthesizer` helper is the model for a `fakeClassifier`

### Institutional Learnings

`docs/solutions/` is still empty. Key candidates for capture once this lands:
- "Anthropic `tool_use` as structured output for non-agentic flows" — using tools without feeding results back, purely as a JSON-validation mechanism
- "Heuristic-gated LLM calls as a latency/cost optimization pattern" — common-case skip plus targeted spend

### External References

- Anthropic Messages API `tools` parameter + `tool_choice: "auto"`: the response contains either a `text` content block (no tool needed) or a `tool_use` block with `name` and `input` fields. `https://platform.claude.com/docs/en/build-with-claude/tool-use`
- Tool definitions take a JSON Schema (`input_schema`) which Claude uses to validate and structure the call. No native execution — the API just returns the chosen tool + args.

---

## Key Technical Decisions

- **Anthropic `tool_use` as the classifier wire format** — declare each skill as a `tool` in the request. With `tool_choice: "auto"`, Claude can emit a `content` array containing a `text` block, a `tool_use` block, or BOTH. Response parsing **scans the full `content` array** for any `tool_use` block (not just `content[0]`). If a `tool_use` block exists anywhere, intent is `tool`. If none, intent is `rag`. **No tool result is fed back**; the classifier call is single-turn structured output. Resolves origin open question Q5.
- **Pipeline event naming follows the existing camelCase convention** (`classifierStart`, `classifierDone`, `classifierSkipped`, `classifierError`, `skillStart`, `skillDone`, `skillFailed`), not dot-separated. The log-line strings can still use dot syntax (`synthesis.start`) for telemetry — but the typed EventEmitter event names mirror `synthesisStart`/`synthesisDelta`/`synthesisDone`.
- **Error taxonomy: single class with discriminated `kind`** — `ClassifierProviderError extends UpwellError` with a `kind` field union: `'auth-error' | 'rate-limit' | 'bad-request' | 'network-error' | 'overloaded' | 'server-error' | 'unknown'`. Matches the `SynthesisProviderError` pattern exactly. No separate `ClassifierRateLimitError` class — 429s map to `{kind: 'rate-limit', retryAfterMs?}`.
- **Tool result gets `rank: 0`** — `formatAsSource` constructs a `SynthesisSource` with `rank: 0`. The retrieval-derived cards retain their original ranks (1, 2, …). The synthesizer's existing prompt cites by 1-indexed position in the sources array, not by the `rank` field, so the rank assignment is for telemetry / consistency, not for citation numbering.
- **Skill registry is per-connector, exported alongside `pull`** — connector modules grow a `skills` field. No central registry config; the daemon discovers skills by enumerating enabled connectors at startup. Resolves origin open question Q3.
- **Skill execution uses FTS5 on chunk text for state/label filters, plain SQL on docs for type/author/updated_at** — avoids a schema migration in v1. The chunker A-E fix already prepends `Status: open` / `Labels: …` to every issue chunk. The corpus FTS5 table uses `tokenize=unicode61 remove_diacritics 2`, which strips most punctuation including `:` — so the MATCH expression should be the **post-tokenization form** `"Status open"` (two consecutive tokens), not the literal-form `"Status: open"`. U2 must verify this against the live tokenizer in a small smoke test before finalizing the MATCH strings.
- **Heuristic matches against the most-recent finalized utterance, NOT the full 30s windowText** — the heuristic input is the latest utterance's text. The 30s `windowText.text` is what the embedder + classifier see for context; the heuristic decision is made on the single triggering utterance only. Otherwise a 30s window containing past tool-shaped utterances (e.g., "list all the cases") would falsely trigger on every subsequent flush, breaking R2. This requires `#evaluate` to thread the latest utterance text into the heuristic call, not just `windowText`.
- **Classifier + retrieval run in parallel via `Promise.all` when the heuristic triggers** — synthesizer holds for both. Bounded by `max(classifier_latency, retrieval_latency)`, not their sum. On either rejecting: catch, log, fall through to RAG-only synthesis. Resolves origin open question Q6.
- **Tool result formatted identically to a retrieval source** — synthetic location header `Tool: github.count` plus a `summary:` line plus optional `items:` list. The synthesizer's existing prompt expects numbered sources with title + body; tool results comply with that shape so no prompt change is needed.
- **Heuristic regex is a single pure function `isToolShaped(text): boolean`** — case-insensitive, anchored on phrase fragments not full sentences. Calibrated against the brainstorm's example questions plus dogfood transcripts. Patterns live in code (not env-tunable v1) so iteration is via PR.
- **Classifier failure modes always fall through to RAG** — 4xx, 5xx, abort, network error, malformed response, classifier returns invalid skill name, skill not in registry, skill execution throws. Every branch logs and proceeds with RAG-only synthesis. Resolves origin D6.
- **No new env vars for v1** — `ANTHROPIC_API_KEY` already exists for the synthesizer. Heuristic patterns and skill registry are code-defined. Model defaults to `claude-haiku-4-5` (same as synthesizer).
- **Classifier instantiation gates only on `ANTHROPIC_API_KEY`; usage gates on consent** — U6 instantiates the classifier whenever the key is present, regardless of consent state. U5's gate before each call invokes `consentCheck()` (the same closure already created for the synthesizer wiring). This means consent revocation takes effect on the next flush without a daemon restart, mirroring the synthesis pattern.
- **`consentCheck` is the existing closure from `serve.ts`** — `() => hasConsent(db, 'anthropic')`. The pipeline option `consentCheck` is reused as-is for the router; no second closure is added. Both the synthesizer gate and the classifier gate consult the same closure.
- **AbortSignal in skills gates result usage, not SQL execution** — better-sqlite3 is synchronous and has no per-query interruption surface. The pipeline checks `signal.aborted` *after* the skill returns and discards the result if a newer flush has been scheduled. The signal is still passed into the skill handler's `ctx` for forward-compatibility but is not actively polled mid-query.

---

## Open Questions

### Resolved During Planning

- **Q1 origin: heuristic regex patterns.** Starting set of 10 patterns covers: `how many`, `count`, `list (all|every)`, `what('s| is) open`, `what('s| are) (open|closed|merged)`, `who has`, `are there any`, `is there`, `find (all|me)`, `show (all|me)`. Patterns are case-insensitive and matched against trimmed lowercased windowText. Final set calibrated during dogfood.
- **Q2 origin: classifier prompt template.** System prompt + 5-7 few-shot examples mirroring the synthesizer's structure: positive cases (each skill appearing at least once), refusal cases (utterance is tool-shaped but no skill fits, → returns text), ambiguous cases (could be tool or RAG, → returns text and lets RAG run).
- **Q3 origin: skill registry shape.** `Skill = { name, description, inputSchema, handler }`. Registry is a class that holds Skills indexed by name and exposes `toToolDefinitions()` for the Anthropic call.
- **Q4 origin: tool result formatting.** Synthesizer source shape: location header `Tool: github.<skillName>(<json args>)`, body is the skill's `summary` + (if applicable) a numbered list of items. Same shape as a code chunk's `// path:lines\n<body>` so the synthesizer's existing prompt cites it consistently.
- **Q5 origin: classifier response shape.** Anthropic `tool_use` request format with `tool_choice: "auto"`. Response is parsed by checking the first content block's `type`: `tool_use` → tool intent; `text` → rag intent.
- **Q6 origin: race semantics.** `Promise.all([classifier, retrieval])`. Synthesizer waits for both. Either failure: caught, logged, treated as `rag` intent and proceed with whatever retrieval surfaced.
- **Q7 origin: telemetry fields.** `classifier.start { traceId }`, `classifier.done { traceId, intent, skillName?, latencyMs, cacheReadTokens, cacheCreationTokens }`, `classifier.skipped { reason: 'heuristic-no-match' | 'no-consent' | 'no-classifier' }`, `skill.start { name, args }`, `skill.done { name, latencyMs, resultShape }`, `skill.failed { name, code, message }`.

### Deferred to Implementation

- **Exact classifier prompt wording.** Drafted in U4; tuned in dogfood. The shape (system instructions + 5-7 few-shots + cache breakpoint) is fixed.
- **Exact JSON Schema for each skill's `inputSchema`.** Drafted in U2 alongside each skill. Implementer iterates as classifier choice quality is measured.
- **Whether `recently_updated` should default to 7 days or 14 days when the classifier omits the `days` arg.** Implementation-time judgment.
- **Whether `list` should include both issues and PRs by default, or require an explicit `type` filter.** Implementation-time choice; `list` will surface this if the dogfood reveals confusion.
- **Race policy when classifier returns AFTER synthesizer has already streamed text.** Should not happen in practice because synthesizer waits on the classifier promise, but the implementation needs to be deliberate about the lifecycle. Likely guarded by an `await` inside `#maybeSynthesize` rather than firing eagerly.

---

## Output Structure

    apps/daemon/src/
    ├── skills/                              # NEW
    │   ├── contract.ts                       # Skill interface + ResultEnvelope + error classes
    │   ├── registry.ts                       # SkillRegistry holding per-connector skills
    │   └── github/                           # NEW connector-scoped skill module
    │       ├── index.ts                      # exports `skills: Skill[]`
    │       ├── count.ts
    │       ├── list.ts
    │       ├── recently_updated.ts
    │       ├── by_author.ts
    │       └── filter.ts                     # shared filter parsing + SQL builders
    └── router/                              # NEW
        ├── heuristic.ts                      # isToolShaped(text): boolean
        ├── anthropic-classifier.ts           # AnthropicClassifier (tool_use request)
        └── prompt.ts                         # classifier system + few-shots

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
finalized utterance
        |
        v
  isToolShaped(text)?
    /              \
  NO                YES
   |                 |
   |       +---------+---------+
   |       v                   v
   |   classify()          embed + hybridSearch
   |  (~400 ms)              (~600 ms)
   |       \                 /
   |        \               /
   |         await Promise.all
   |                 |
   |          classifier result
   |          ├── intent: 'tool', skillName, args
   |          │       v
   |          │   registry.execute(skillName, args)
   |          │       └── on throw: log, treat as rag
   |          │       v
   |          │   toolSource = formatAsSource(result)
   |          │       v
   |          │   synthesize({ sources: [toolSource, ...cardSources] })
   |          │
   |          └── intent: 'rag' (text response, no tool_use block)
   |                  v
   |              synthesize({ sources: cardSources })
   |
   v
synthesize({ sources: cardSources })     // unchanged today path
```

Note the asymmetry: cards from the RAG branch *always* render in the HUD immediately when they arrive (existing `emit('card')` path). The classifier only delays the *synthesis* call, not the raw card emit. So user-visible TTFT for raw cards is unchanged.

---

## Implementation Units

- [x] U1. **Skill contract + registry**

**Goal:** Stand up the `Skill` interface, `SkillRegistry` class, error classes, and the `toToolDefinitions()` adapter that builds Anthropic tool descriptors from registered skills.

**Requirements:** R6, R7

**Dependencies:** none

**Files:**
- Create: `apps/daemon/src/skills/contract.ts`
- Create: `apps/daemon/src/skills/registry.ts`
- Create: `apps/daemon/test/skills/registry.test.ts`

**Approach:**
- `Skill` interface: `{ source: string, name: string, description: string, inputSchema: JsonSchema, handler: (args, ctx) => Promise<SkillResult> }`. `ctx` carries `{ db, signal, now? }`.
- `SkillResult`: `{ kind: 'count' | 'list' | 'detail', summary: string, items?: Array<{title, url?, ...}>, raw?: unknown }`. The `summary` is what the synthesizer's source body uses; `items` is optionally formatted into a numbered list inside the body; `raw` is for telemetry only.
- `SkillRegistry` class: `register(skill)`, `lookup(name)`, `list()`, `toToolDefinitions(): AnthropicToolDef[]` — the adapter formats each Skill as `{ name, description, input_schema }` for the Anthropic API.
- Error classes: `SkillExecutionError` (skill threw), `SkillUnknownError` (classifier picked a name not in the registry). Both extend `UpwellError`.
- `formatAsSource(result, skillName, args): SynthesisSource` — converts a skill result to a SynthesisSource the synthesizer's prompt expects. Returns `{ rank: 0, title: ..., text: ... }`. The `rank: 0` is for telemetry consistency; the synthesizer cites by position in the sources array, not by `rank` value. Location/title reads `Tool: github.count({"state":"open"})`; body is `Count result: 7. Matching: #1, #6, #14, ...`.

**Patterns to follow:**
- `apps/daemon/src/embed/contract.ts` — error class pattern; interface + types in contract.ts, class implementations in sibling files
- `apps/daemon/src/synthesize/contract.ts` — for the `SynthesisSource` shape that `formatAsSource` must produce

**Test scenarios:**
- Happy path — register two skills, list returns both in registration order, lookup by name returns the right Skill.
- Edge case — duplicate skill name on register throws.
- Edge case — lookup of unknown name returns undefined; caller decides whether that's an error.
- Integration — `toToolDefinitions()` produces objects with exactly `{ name, description, input_schema }`; no extra fields leak.
- Integration — `formatAsSource(SkillResult, 'github.count', {state:'open'})` produces a SynthesisSource with `rank: 0`, the correct location header, and body string layout; numbered items render with leading `#N`.

**Verification:** All scenarios pass. The shape is consumed downstream by U4 (classifier passes tool definitions to Anthropic) and U5 (pipeline formats result).

- [x] U2. **GitHub skill set (count / list / recently_updated / by_author)**

**Goal:** Four read-only skills that query the local corpus directly. Each filters by some combination of type/state/labels/author/updated_at using FTS5 for chunk-text searches and plain SQL for doc-level fields.

**Requirements:** R1, R8

**Dependencies:** U1

**Files:**
- Create: `apps/daemon/src/skills/github/filter.ts`
- Create: `apps/daemon/src/skills/github/count.ts`
- Create: `apps/daemon/src/skills/github/list.ts`
- Create: `apps/daemon/src/skills/github/recently_updated.ts`
- Create: `apps/daemon/src/skills/github/by_author.ts`
- Create: `apps/daemon/src/skills/github/index.ts` (exports `skills: Skill[]`)
- Create: `apps/daemon/test/skills/github/count.test.ts`
- Create: `apps/daemon/test/skills/github/list.test.ts`
- Create: `apps/daemon/test/skills/github/recently_updated.test.ts`
- Create: `apps/daemon/test/skills/github/by_author.test.ts`

**Approach:**
- `filter.ts` exposes:
  - `buildDocFilter({ type?, state?, labels?, author? }): { sql: string, params: unknown[] }` — builds the WHERE clause for the docs table
  - `chunkTextMatch({ state?, labels? }): string | null` — builds the FTS5 MATCH expression or returns null if neither state nor labels were specified. The expression uses **post-tokenization form** (e.g., `"Status open"`, `"Labels bug"`) because the configured `unicode61` tokenizer strips `:` from `Status: open`. **Smoke-test the MATCH form against the actual indexed corpus before locking the strings.**
  - Filters that combine multiple labels use FTS5 phrase queries joined with AND
- `count(filter)` skill — joins docs + (when needed) `fts_doc_chunks MATCH` to count distinct doc_ids. Result: `{ kind: 'count', summary: 'N matching docs', raw: { count: N } }`.
- `list(filter, limit?)` — same join, returns up to `limit` (default 10, max 25) rows of `{ number, title, state, url }` from docs. Result body includes a numbered list of items.
- `recently_updated(days?)` — `WHERE updated_at >= now - days * 86400000 ORDER BY updated_at DESC LIMIT N`. Default `days=7`, `limit=10`. Result body lists items by recency.
- `by_author(login, filter?)` — combines `docs.authors LIKE ?` (matching `"<login>"` inside the JSON array string) with the optional sub-filter. Result body lists matching docs.
- All skills accept an `AbortSignal` in `ctx`, but actual abort handling is at the caller side (U5): the pipeline checks `signal.aborted` after the skill returns and discards the result if a newer flush has aborted. Skills themselves do not poll the signal mid-query — better-sqlite3 is synchronous and short-running on the v1 corpus (~10 ms per skill); per-query interruption isn't necessary.

**Patterns to follow:**
- `apps/daemon/src/corpus/query.ts` `hybridSearch` — db connection passed in, no per-call open/close; prepared statements; row → typed result mapping
- The chunker's text format (`Issue Nath5/upwell#X — Title. Status: open. Labels: bug.`) — FTS5 MATCH expressions must align with this exact format

**Test scenarios:**
- Happy path — `count({type:'issue', state:'open'})` against a seeded corpus with 7 open + 3 closed issues returns `summary: '7 open issues'`.
- Happy path — `list({type:'issue', state:'open'}, 5)` returns 5 items, each with `number`, `title`, `state`, `url`.
- Edge case — empty result: `count` returns 0 with `summary: 'No matching docs.'`. `list` returns an empty items array.
- Edge case — `list` with `limit > 25` is capped at 25 silently (or rejected — implementer's call documented in the unit).
- Edge case — `by_author('unknown-login')` returns 0 / empty.
- Edge case — `recently_updated()` with no days argument defaults to 7.
- Error path — `count({state: 'open'})` without `type` filter still returns a count (all open docs across types).
- Integration — combined filter: `count({type:'issue', state:'open', labels:['bug']})` correctly intersects all three filters; FTS5 MATCH compiles to `"Status: open" AND "Labels: bug"`.
- Integration — `by_author` with `filter.state='open'` correctly combines docs.authors match with chunk-text FTS5 match.

**Verification:** All scenarios pass against a test corpus seeded with 10–20 fixture issues + PRs. The `index.ts` exports the four skills in a stable order so registry tests can assert position.

- [x] U3. **Heuristic gate (isToolShaped)**

**Goal:** A single pure function that classifies an utterance as tool-shaped or RAG-shaped, fast and free.

**Requirements:** R2, R9

**Dependencies:** none

**Files:**
- Create: `apps/daemon/src/router/heuristic.ts`
- Create: `apps/daemon/test/router/heuristic.test.ts`

**Approach:**
- Export `isToolShaped(text: string): boolean` and `HEURISTIC_PATTERNS: readonly RegExp[]` (the latter for tests).
- Patterns are case-insensitive, matched against the lowercased trimmed input. **The caller (U5) is responsible for passing only the most-recent finalized utterance**, not a windowText that may contain stale tool-shaped phrases from earlier in the meeting. The function itself is stateless and doesn't know about windowing.
- Starting set covers: counting (`how many`, `count`), listing (`list all`, `list every`, `show all`, `show me all`, `find all`), state queries (`what's open`, `what is open`, `any open`, `are there any open`), author queries (`who has`, `who owns`, `assigned to`, `authored by`), temporal (`recently updated`, `updated this week`, `changed since`).
- The function is pure — no caching, no statefulness. ~5 µs per call.
- Anti-pattern guardrails: don't trigger on `how does` (likely a how-to RAG question), `what does` (likely a definition RAG question). The patterns explicitly anchor on noun-phrase shapes.

**Test scenarios:**
- Happy path — every brainstorm example utterance matches: `how many open issues are there`, `list all PRs by jamie`, `what was updated this week`, `are there any phase 2 issues`.
- Negative — RAG-shaped utterances don't match: `how does the sidecar handshake work`, `what is plan unit U13`, `tell me about the synthesizer architecture`.
- Edge case — empty string returns false, no throw.
- Edge case — single word like `count` matches; surrounding noise like `… and the count of …` matches too.
- Edge case — mixed case (`How MANY Open Issues`) matches.
- Edge case — leading/trailing whitespace and punctuation don't break matching.

**Verification:** All scenarios pass. Pattern list can be reviewed in isolation; adding a new pattern is a one-line append + a test.

- [x] U4. **Anthropic classifier client + prompt assembly**

**Goal:** A non-streaming Anthropic Messages call using `tool_use` request format. Given an utterance and a list of available skills (as tool definitions), returns either `{intent: 'rag'}` or `{intent: 'tool', skillName, args}`. Handles 429 / 5xx / abort / network errors with the same retry/backoff pattern as `AnthropicSynthesizer`.

**Requirements:** R5, R9, R10

**Dependencies:** U1 (for `SkillRegistry.toToolDefinitions()`)

**Files:**
- Create: `apps/daemon/src/router/anthropic-classifier.ts`
- Create: `apps/daemon/src/router/prompt.ts`
- Create: `apps/daemon/test/router/anthropic-classifier.test.ts`
- Create: `apps/daemon/test/router/prompt.test.ts`

**Approach:**
- `AnthropicClassifier` constructor mirrors `AnthropicSynthesizer`: `{apiKey, baseUrl?, model?, fetchImpl?, maxRetries?, onUsage?, onRetryWait?}`. Defaults to `claude-haiku-4-5`.
- `classify({utterance, registry, signal?}): Promise<ClassifierResult>` where `ClassifierResult = {intent: 'rag'} | {intent: 'tool', skillName, args}`.
- Request body: `{ model, max_tokens: 200, stream: false, system: [{type:'text', text: PROMPT, cache_control: {type:'ephemeral'}}], tools: registry.toToolDefinitions(), tool_choice: {type:'auto'}, messages: [{role:'user', content: utterance}] }`.
- Response parsing: **scan the full `content` array** for any block with `type === 'tool_use'`. If found, extract its `name` and `input` (return `{intent: 'tool', skillName: name, args: input}`). If no `tool_use` block exists anywhere in `content`, return `{intent: 'rag'}`. This is robust against Anthropic responses that emit a preamble `text` block before the `tool_use` block — reading only `content[0]` would silently misclassify those as `rag`.
- `prompt.ts` exports `CLASSIFIER_SYSTEM_PROMPT: string` and `CLASSIFIER_FEW_SHOTS: FewShot[]`. Combined text must be ≥4096 tokens (~16000 chars proxy, same threshold as the synthesizer) for Haiku caching to engage. Natural content from 5-7 few-shots is likely to land around ~2000 tokens; **expect to pad with additional diverse-phrasing examples** (different ways users might phrase the same intent) to clear the cache threshold. Avoid padding by repeating identical examples — diverse phrasings double as quality calibration and stay productive. Cache breakpoint sits on the system block.
- Retry / abort / error mapping mirrors `AnthropicSynthesizer`. **Single error class** `ClassifierProviderError extends UpwellError` with discriminating `kind`: `'auth-error' | 'rate-limit' | 'bad-request' | 'network-error' | 'overloaded' | 'server-error' | 'unknown'`. 429 responses produce `{kind: 'rate-limit', retryAfterMs?}`. No separate `ClassifierRateLimitError` class.

**Patterns to follow:**
- `apps/daemon/src/synthesize/anthropic.ts` — constructor shape, `fetchImpl` injection, retry loop, abort handling
- `apps/daemon/src/synthesize/prompt.ts` — system block + few-shots + cache_control on last block + ≥4096-char proxy assertion

**Test scenarios:**
- Happy path — `tool_use` response with `name: 'github.count'` and `input: {state: 'open', type: 'issue'}` is parsed into `{intent: 'tool', skillName, args}`.
- Happy path — `text` response (no tool_use block) parses to `{intent: 'rag'}`.
- **Edge case — content array contains BOTH a `text` block AND a `tool_use` block** (the model emitted a preamble): parser MUST return `{intent: 'tool', ...}`, not `{intent: 'rag'}`. This is the load-bearing test for the response-parsing fix.
- Edge case — `tool_use` with an unknown `name` not in registry: classifier itself doesn't validate against the registry (that's U5's job); it returns the name as-is.
- Edge case — empty utterance: no special-casing; classifier still runs (caller is responsible for the heuristic guard).
- Error path — 429 with Retry-After honored, then second attempt succeeds.
- Error path — 401: throws `ClassifierProviderError` with `kind: 'auth-error'`, no retry.
- Error path — 429 after retries exhausted: throws `ClassifierProviderError` with `kind: 'rate-limit'`, `retryAfterMs` populated.
- Error path — abort during call: throws `AbortError` sentinel (not `ClassifierProviderError`).
- Integration — request body has tools array populated from a registry with 4 skills; each tool definition has `{name, description, input_schema}`.
- Integration — request has `tool_choice: {type: 'auto'}`.
- Integration — `system` is an array; last block has `cache_control: {type: 'ephemeral'}`.
- Integration — `prompt.ts` exported system+few-shot text is ≥16000 characters (proxy for ≥4096 tokens, same threshold as synthesizer).
- Integration — `CLASSIFIER_FEW_SHOTS` includes at least one example per skill (`github.count`, `github.list`, `github.recently_updated`, `github.by_author`) AND at least one refusal example (returns a text response).

**Verification:** All scenarios pass. Manual smoke: with a real `ANTHROPIC_API_KEY`, calling `classify({utterance: 'how many open issues are there', registry})` returns `{intent: 'tool', skillName: 'github.count', args: {type: 'issue', state: 'open'}}` within ~1 second on first call.

- [x] U5. **Pipeline integration: gate, parallel race, skill execute, synthesizer merge**

**Goal:** Orchestrate the router behavior inside `RetrievalPipeline.#evaluate()`: heuristic on windowText → if triggered, fire classifier + retrieval in parallel via `Promise.all` → if classifier picks a skill, execute it via the registry → format tool result as a numbered source → pass to synthesizer with the RAG cards. Every failure mode falls through to RAG-only synthesis.

**Execution note:** Test-first for the orchestration. The parallel-promise lifecycle and the multiple failure modes are subtle; pinning behavior in tests before writing the wiring makes the logic clear.

**Requirements:** R1, R3, R4, R7

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `apps/daemon/src/retrieve/pipeline.ts`
- Modify: `apps/daemon/src/retrieve/contract.ts` (extend `RetrievalPipelineEvents` with 7 new events: `classifierStart`, `classifierDone`, `classifierSkipped`, `classifierError`, `skillStart`, `skillDone`, `skillFailed`)
- Modify: `apps/daemon/test/retrieve/pipeline.test.ts`

**Approach:**
- Extend `RetrievalPipelineOptions` with `classifier?: Classifier`, `skillRegistry?: SkillRegistry`. Both undefined = router disabled, pipeline behaves exactly as before. The existing `consentCheck?: () => boolean` option is reused — no separate `routerConsentCheck`. The same closure already gates the synthesizer.
- Extend `RetrievalPipelineEvents` in `contract.ts` with the 7 new typed events (payloads detailed below in **Pipeline event payloads**). All names use camelCase to match the existing `synthesisStart` / `synthesisDelta` / `synthesisDone` convention.
- At the top of `#evaluate`, after `windowText.text` is known but before embedding, call `isToolShaped(latestUtteranceText)`. **The heuristic input is the text of the latest finalized utterance, not the full 30s windowText.** This requires threading the triggering utterance text into `#evaluate` — currently it has `utteranceId` but the text is in the window. Plumb `utteranceText` through `#flush`/`runOnce` from the caller (`engine.on('final', ...)` already has the text).
  - If false: existing path unchanged, no router log line beyond a single `classifierSkipped { reason: 'heuristic-no-match' }` at debug level (or omit entirely to avoid noise — implementer's call).
  - If true AND both classifier and registry are defined AND `consentCheck()` returns true: fire `Promise.allSettled([classifier.classify({utterance: latestUtteranceText, registry, signal}), this.#runRetrievalPath(windowText, controller, traceId, utteranceId)])`.
  - **Refactor side-effects of `#runRetrievalPath`:** the method must (a) keep the `this.emit('card', card)` calls *inside* the loop so raw cards ship to the HUD as they're ready, NOT held by the classifier; (b) move `#inflight++ / --` so they bracket the whole router branch (the wrapper increments once at start of `#evaluate`, decrements once at end); (c) return `{ cards: CardEvent[], embedded: EmbedResult, results: HybridResult[], traceFragments }` so the synthesis gate can run in the wrapper, not inside `#runRetrievalPath`.
  - After settle: if the classifier promise rejected: emit `classifierError`, log, treat as `rag` intent. If it returned `{intent: 'rag'}` OR `{intent: 'tool', skillName}` where `registry.lookup(skillName) === undefined`: log and treat as `rag` (emit `skillFailed { code: 'unknown-skill' }` for the latter case). Otherwise execute the skill: `await registry.lookup(skillName).handler(args, { db: this.#db, signal, now: this.#now })`. On skill throw: emit `skillFailed`, log, ignore the result.
  - After the parallel join completes (and skill execution if applicable), the existing synthesis gate fires from the wrapper. Build the `sources` array passed to `#maybeSynthesize`: `[toolSource, ...cardSources]` if a tool result exists, else `[...cardSources]`. The synthesis gate's existing emittedCards.length > 0 check applies to the cardSources only — a tool result alone does NOT trigger synthesis (the user wouldn't see cards otherwise, breaking the "raw cards + synthesis" contract).
  - Cards from the RAG leg are emitted as they're ready inside `#runRetrievalPath` via `this.emit('card', card)`; only the *synthesizer* call is held until the parallel join completes.
- **Pipeline event payloads:**
  - `classifierStart { traceId }`
  - `classifierDone { traceId, intent: 'rag' | 'tool', skillName?, latencyMs, usage }`
  - `classifierSkipped { traceId, reason: 'heuristic-no-match' | 'no-classifier' | 'no-consent' }`
  - `classifierError { traceId, code: ClassifierProviderError['kind'], message?, retryAfterMs? }`
  - `skillStart { traceId, name, args }`
  - `skillDone { traceId, name, latencyMs, resultShape: 'count' | 'list' | 'detail' }`
  - `skillFailed { traceId, name?, code: 'unknown-skill' | 'execution-error' | 'aborted', message? }`

**Patterns to follow:**
- The existing `#maybeSynthesize` shape — fire-and-forget, but here we extend it to take a sources array including tool result
- The synthesizer's `SynthesisInput` shape (sources are already a list)
- `SynthesisProviderError` style for `ClassifierProviderError` mapping in U4

**Test scenarios:**
- Gate — heuristic false (RAG-shaped utterance): classifier is NOT called; existing RAG path runs unchanged; no `classifierStart` event emitted.
- Gate — heuristic true, no classifier configured: existing RAG path runs unchanged; emits `classifierSkipped { reason: 'no-classifier' }`.
- Gate — heuristic true, no consent: existing RAG path runs; emits `classifierSkipped { reason: 'no-consent' }`.
- **Gate — windowText contains stale tool-shaped phrasing BUT latest utterance is RAG-shaped:** classifier is NOT called. The heuristic input MUST be the latest utterance, not the windowText. This is the load-bearing test for the heuristic-input fix.
- Happy path — heuristic true, classifier returns `{intent: 'tool', skillName: 'github.count', args}`: skill executes, tool result becomes source[0] of the synthesizer input, synthesizer is called with `[toolSource, ...cards]`. Assert `classifierDone { intent: 'tool', skillName }` and `skillDone { name, resultShape: 'count' }` events fire in order.
- Happy path — heuristic true, classifier returns `{intent: 'rag'}` (false alarm): synthesizer is called with `[...cards]` only. Assert `classifierDone { intent: 'rag' }` fires, no `skillStart`.
- Error path — classifier rejects with `ClassifierProviderError { kind: 'auth-error' }`: caught, emits `classifierError`, treated as `rag`, synthesizer runs with cards only.
- Error path — classifier rejects with `ClassifierProviderError { kind: 'rate-limit', retryAfterMs }`: same fallback; the `classifierError` event payload includes `retryAfterMs`.
- Error path — classifier returns `{intent: 'tool', skillName: 'github.unknown'}` not in registry: emits `skillFailed { code: 'unknown-skill' }`, treated as `rag`.
- Error path — skill execution throws: emits `skillFailed { code: 'execution-error' }`, treated as `rag`.
- **Integration — raw cards emit BEFORE the classifier resolves (parallel timing):** drive a fake classifier with an artificial 1s delay; assert all `card` events fire from the retrieval leg before the 1s mark and before any `synthesisStart`. This is the load-bearing test that `#runRetrievalPath` emits cards inline rather than holding them.
- Integration — abort: scheduling a new flush mid-classifier aborts the controller; the in-flight skill (if started) has its result discarded post-return rather than being interrupted.
- Integration — retrieval leg rejects (e.g., voyage rate-limited): synthesizer is NOT called; behavior matches today's "embed error → no synthesis" path. Tool result alone does not trigger synthesis.
- Integration — `#inflight` accounting: starts at 0, increments to 1 on `#evaluate` entry (regardless of router path), decrements to 0 on exit even if the classifier and/or skill failed.

**Verification:** All scenarios pass. Pipeline tests already cover the non-router paths; adding the router options leaves the no-router-configured path identical to today.

- [x] U6. **Serve.ts wiring + telemetry log lines**

**Goal:** Instantiate the classifier + skill registry at daemon startup, pass to the pipeline, and emit the structured log lines that resolve open question Q7.

**Requirements:** R5, R10

**Dependencies:** U5

**Files:**
- Modify: `apps/daemon/src/cli/serve.ts`
- Modify: `.env.example` (no new vars; doc the implied reuse)
- Modify: `apps/daemon/test/cli/serve.test.ts` (if it exists; otherwise narrow unit test in `router/`)

**Approach:**
- Instantiate `SkillRegistry` and register all skills from enabled connectors. For v1 only GitHub: `import { skills as githubSkills } from '../skills/github/index.js'` and `for (const s of githubSkills) registry.register(s)`.
- If `ANTHROPIC_API_KEY` is set (same gate as the synthesizer), instantiate `AnthropicClassifier` with the same key + model. Instantiation does NOT check consent — the consent check happens at usage time inside the pipeline, so consent revocation takes effect on the next flush without a daemon restart.
- Pass `classifier` + `skillRegistry` into the `RetrievalPipeline` constructor options. The existing `consentCheck` closure is shared with the synthesizer; no second closure needed.
- Subscribe to the 7 new pipeline events emitted from U5 and bridge to structured log lines:
  - `classifierStart` → `log('info', 'classifier.start', { traceId })`
  - `classifierDone` → `log('info', 'classifier.done', { traceId, intent, skillName, latencyMs, cacheReadTokens, cacheCreationTokens })`
  - `classifierSkipped` → `log('info', 'classifier.skipped', { traceId, reason })` — note the dot in the log string is for telemetry; the typed event is camelCase
  - `classifierError` → `log('warn', 'classifier.error', { traceId, code, message, retryAfterMs })`
  - `skillStart` → `log('info', 'skill.start', { traceId, name, args })`
  - `skillDone` → `log('info', 'skill.done', { traceId, name, latencyMs, resultShape })`
  - `skillFailed` → `log('warn', 'skill.failed', { traceId, name, code, message })`
- `.env.example` gets a comment block noting that the synthesis ANTHROPIC_API_KEY also enables the router classifier; no separate key.

**Patterns to follow:**
- The synthesizer wiring block in `serve.ts` from the prior plan — same shape: gate on key, instantiate, pass via options, log lines on event emit

**Test scenarios:**
- Happy path — `ANTHROPIC_API_KEY` set + consent granted: classifier and registry are both passed to pipeline.
- Edge case — no `ANTHROPIC_API_KEY`: pipeline receives `classifier: undefined`, registry IS still passed (so the gate explicitly logs "no classifier" rather than "no registry" if someone wants both to know).
- Edge case — registry has 0 skills (no connectors enabled): pipeline still receives the empty registry, classifier is never useful, log lines reflect the empty state.

**Verification:** Daemon starts cleanly with and without the env vars. The pipeline's router gate behavior matches U5's tests when wired through serve.ts.

---

## System-Wide Impact

- **Interaction graph:** `RetrievalPipeline` gains a heuristic-gated parallel branch. The synthesizer is unchanged in shape — it still takes a `sources` array. The HUD is entirely unchanged: tool results just appear as another numbered citation chip.
- **Error propagation:** All router failures are caught and demoted to "fall back to RAG." No router failure can break the existing RAG-synthesis path. Pipeline tests already cover the no-classifier-configured baseline; new tests cover every router failure mode.
- **State lifecycle risks:** The skill registry is constructed once at startup and shared across meetings. Skill handlers are stateless — they take args + a `ctx` and return a result. No per-meeting state to clean up.
- **API surface parity:** No external API contracts change. The Anthropic auth and consent surfaces are unchanged (reuse existing).
- **Integration coverage:** The parallel `Promise.allSettled` is the highest-risk interaction. U5's test scenarios explicitly cover both promises succeeding, either rejecting, and the abort path. The skill SQL also needs integration testing against a real (test) corpus — U2 covers this.
- **Unchanged invariants:** The existing `card` / `cardUpdated` / `cardRetracted` / `synthesisStart` / `synthesisDelta` / `synthesisDone` event shapes do not change. The HUD's existing card rendering is untouched. The retrieval contract (RRF score, rank, snippet format) is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Heuristic false negatives (aggregation queries that slip past the regex) | Patterns are pure function in code; new patterns are one-line additions. Dogfood will surface real misses. The existing RAG refusal path is graceful for misses. |
| Heuristic false positives (RAG queries that look aggregation-shaped) | Classifier returns `{intent: 'rag'}` in this case — false-positive cost is one classifier call (~$0.001 + ~400 ms parallel-ed with retrieval). Net cost: bounded. |
| Classifier picks the wrong skill (e.g., uses `list` when `count` is right) | Synthesizer still receives the (wrong-for-shape but related) tool result + RAG snippets and produces something. User isn't blocked. Telemetry on `classifier.done` lets us measure choice quality from logs. |
| Skill SQL slowness on a large corpus | Skills use existing indexes; FTS5 is fast. `count` is O(matching chunks). For v1's dogfood corpus (~400 chunks), every skill returns in <10 ms. Larger corpora may need indexing review — explicit follow-up if it shows up. |
| Adding state column to docs becomes necessary | Already noted as deferred follow-up; v1 ships without it. The FTS5 approach is correct, just less elegant. |
| Anthropic tool_use semantics change | Anthropic API is versioned (`anthropic-version: 2023-06-01`). Pinning the version protects against silent break. |
| Cost overrun if heuristic triggers too aggressively | Telemetry on `classifier.skipped {reason: 'heuristic-no-match'}` and `classifier.done` lets us measure trigger rate. Patterns are tunable in code. |
| Classifier latency + retrieval latency together delaying synthesis | They run in parallel, so total latency is `max(classifier, retrieval)`, not their sum. Empirically classifier is 300-500 ms, retrieval is 500-800 ms — net delta is near zero. |

---

## Documentation / Operational Notes

- `.env.example` notes that `ANTHROPIC_API_KEY` enables both synthesizer and classifier (single key, single consent grant).
- The chunker's natural-language `Status: open. Labels: …` prefix is *load-bearing* for the skill SQL (FTS5 phrase queries). If the chunker output format changes in a future plan, the skill filters in U2 must change in lockstep — there's a coupling worth documenting in code comments.
- Rollout: ship with `ANTHROPIC_API_KEY` configured + `consent grant anthropic` already granted (same as synthesis). Users without those see the existing RAG-only behavior.
- Once dogfood data exists, the heuristic patterns + classifier prompt are the two tuning knobs. Both live in code; iteration is via PR.

---

## Sources & References

- **Origin document:** [`docs/brainstorms/router-skills-framework-requirements.md`](../brainstorms/router-skills-framework-requirements.md)
- Related code: `apps/daemon/src/retrieve/pipeline.ts`, `apps/daemon/src/synthesize/anthropic.ts`, `apps/daemon/src/synthesize/prompt.ts`, `apps/daemon/src/corpus/query.ts`, `apps/daemon/src/cli/consent-store.ts`
- Related PRs: synthesis card lands at `feat/llm-synthesis-card` (this branch's parent for now; once merged, this plan's branch should rebase onto main)
- External docs: Anthropic `tool_use` reference: `https://platform.claude.com/docs/en/build-with-claude/tool-use`
