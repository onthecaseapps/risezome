---
title: "feat: Lift router/skills framework + GitHub skills into the bot-worker production Recall path"
type: feat
status: completed
date: 2026-05-31
origin: docs/brainstorms/router-skills-framework-requirements.md
---

# Skill Routing in the Production Recall Path

## Overview

The daemon (legacy desktop POC) already has a working router/skills
framework: a heuristic-gated Anthropic classifier picks between
`rag` and `tool` intents per utterance; tool intent dispatches to a
named skill in a `SkillRegistry`; the skill's result is wrapped as a
`SynthesisSource` and fed to the synthesizer alongside any vector-
retrieval cards. Eight GitHub skills are wired in (four corpus-backed,
four live-API). The bot-worker (production Recall path) has none of
this — its `maybeRetrieveAndEmit` is vector-search + synthesis only.

This plan lifts the framework into the engine package, wires it into
the bot-worker's per-meeting pipeline, and brings over the eight
GitHub skills.

The live-API skills (issue_assignees, by_assignee_count,
by_assignee_list, issue_progress + person helper) lift cleanly because
they make API calls and don't touch the corpus. The corpus skills
(count, list, by_author, recently_updated) face a real prerequisite:
**the bot-worker's Postgres corpus has zero GitHub issues or PRs in
it today** — the portal's `app/api/github/` install-callback path and
the Inngest indexer (`apps/portal/src/inngest/functions/index-repo.ts`)
only index repo *files*, not issues. This plan therefore brings the
daemon's `pull-delta.ts` issue/PR indexer over to the cloud (U5) and
THEN ports the corpus skills against the Postgres schema (U6) so they
have data to query.

When the classifier runs, it now receives meeting context
(`current_topic` + `open_questions`) from the rolling-summary
runtime that just shipped — short transcribed utterances like
"how many of those open" can be disambiguated against the meeting's
established frame instead of being dropped by the `isToolShaped`
heuristic in isolation.

After this lands, real Recall meetings can answer:
- "How many open issues do we have?" (corpus skill: `github_count`)
- "What's Sarah working on?" (live skill: `github_by_assignee_list`)
- "Who's on issue 14?" (live skill: `github_issue_assignees`)
- "Show me PRs from last week" (corpus skill: `github_recently_updated`)
- "Has there been progress on #42?" (live skill: `github_issue_progress`)

---

## Problem Frame

The bot-worker's `apps/bot-worker/src/retrieval.ts` does one thing on
each finalized utterance: embed the rolling window, search the
Postgres corpus, emit top-K cards, and stream a synthesis answer. That
shape works for "what does our auth do?"-style questions where the
answer lives verbatim in a code chunk or issue body. It fails for
**structured questions** the corpus can answer with SQL but a vector
search can't — counts, filters, assignee lookups — and for **live-API
questions** where freshness is load-bearing (an issue reassigned an
hour ago).

The daemon already solved this:
- `apps/daemon/src/router/anthropic-classifier.ts` — Anthropic
  Messages call with the registered skills exposed as tools; returns
  `{intent: 'tool', skillName, args}` or `{intent: 'rag'}`.
- `apps/daemon/src/router/heuristic.ts` — cheap regex gate that
  short-circuits the classifier for utterances that clearly aren't
  tool-shaped, so most filler doesn't burn an API call.
- `apps/daemon/src/skills/registry.ts` + `contract.ts` — registry
  + `Skill` interface (name, description, JSON schema, async handler).
- `apps/daemon/src/skills/github/*.ts` — eight skills.
- `apps/daemon/src/retrieve/pipeline.ts` (lines ~315-595) — the
  orchestration: classifier launched in parallel with embed+retrieve,
  result collected after retrieval, tool result wrapped as
  `SynthesisSource` and prepended to the synthesizer's sources array.

That pipeline runs in `apps/daemon/src/cli/serve.ts` (a local HTTP
server) and is what makes the daemon's `serve` command answer
structured questions. The portal's `/debug/ask` page does **not**
currently consume it (it's vector+FTS only). The bot-worker doesn't
consume it either.

(see origin: `docs/brainstorms/router-skills-framework-requirements.md`,
`docs/brainstorms/github-live-skills-requirements.md`)

---

## Requirements Trace

- R1. The bot-worker's `maybeRetrieveAndEmit` runs a classifier on
  each tool-shaped final utterance and, on `tool` intent, executes the
  named skill and feeds its result to the synthesizer alongside any
  retrieved cards. (Lift R1-R6 from the router/skills framework
  brainstorm to the production path.)
- R2. The cheap regex heuristic (`isToolShaped`) gates the classifier
  call so most filler doesn't burn an Anthropic request — same cost
  shape the daemon ships with today.
- R3. The four live-API GitHub skills run on the bot-worker exactly as
  they do on the daemon: `github_issue_assignees`,
  `github_by_assignee_count`, `github_by_assignee_list`,
  `github_issue_progress`. The `resolvePerson` helper (try-as-login →
  GitHub user-search fallback) comes along (origin
  `github-live-skills` D2).
- R4. The four corpus-backed GitHub skills run on the bot-worker
  against the **Postgres** corpus (not SQLite): `github_count`,
  `github_list`, `github_by_author`, `github_recently_updated`. The
  classifier's tool list + arg schemas stay identical so the prompt
  prefix cache survives the move.
- R5. Skill failures (rate-limit, auth, 404, network) propagate as
  `SkillExecutionError` with typed `executionCode`; the pipeline logs
  `skillFailed` and the synthesizer falls through to RAG-only
  synthesis (or refuses gracefully if no cards either).
- R6. `UPWELL_GITHUB_REPO` + `GITHUB_TOKEN` env vars gate the live
  skills at registry-build time. If absent, live skills aren't
  registered (log: `github.live.disabled reason=no-repo|no-token`).
  Corpus skills don't depend on those env vars.
- R7. The classifier's worked-example prompt — 600+ lines of iterated
  examples — comes along verbatim. Editing the prompt mid-lift would
  conflate two changes; iterate after the lift is stable.
- R8. Existing bot-worker behavior is preserved when the classifier
  returns `rag` or when the heuristic short-circuits — vector search
  + cards + synthesis run unchanged from today. The skill branch is
  additive, not replacement.
- R9. The portal indexes GitHub issues + PRs into the Postgres corpus
  (`docs.type IN ('issue', 'pull-request')`, chunked with status
  + labels embedded in chunk text matching the daemon's existing
  format) so the corpus skills have data to query.
- R10. The classifier receives meeting context (`current_topic` +
  `open_questions`) from the rolling-summary runtime when available,
  so short transcribed utterances ("how many of those still open")
  can be classified in-context rather than judged in isolation.

---

## Scope Boundaries

- No changes to the daemon. The daemon keeps its copy of the
  framework + skills as the working POC. After this plan lands, the
  daemon and bot-worker have two implementations; consolidation
  (deleting the daemon copies once the bot-worker version proves
  out) is deferred work, not part of this plan.
- No portal-side `/debug/ask` skill integration. The user's mental
  model was that `/debug/ask` "already supports this" — it doesn't
  (it's vector+FTS only). Adding a portal-facing skill debug surface
  is a follow-up plan.
- No new GitHub skills beyond the eight already designed. The
  classifier prompt's worked examples carry over as-is.
- No multi-repo or multi-source classifier routing — single-repo
  v1 constraint from `github-live-skills` D3 carries over.
- No write actions. Upwell stays read-only (`github-live-skills`
  identity boundary).
- No caching layer for API responses — `github-live-skills` D6
  scope boundary carries over.
- No GitHub corpus comments/timeline ingestion in U5 — issue + PR
  body + metadata (title, state, labels, assignees, authors,
  updated_at) is enough for the corpus skills (count, list,
  by_author, recently_updated). Comment threads and event
  timelines are deferred; if a user wants comment-level recall
  they use `github_issue_progress` (live API).

### Deferred to Follow-Up Work

- **Consolidate daemon + bot-worker skill implementations**: once the
  bot-worker version is stable, delete the daemon's copies and import
  the engine-package framework. Separate PR.
- **Portal `/debug/ask` skill-aware mode**: render classifier intent
  + skill result alongside vector hits for prompt iteration. Separate
  plan.
- **Comment + timeline ingestion into the corpus**: U5 indexes
  issues + PR metadata + body only. Adding `issue_comments` /
  `issue_events` rows is a natural extension once the basic
  indexer proves out.
- **Repo selection UI for multi-repo orgs**: U5 ingests for
  `UPWELL_GITHUB_REPO` (env-pinned, same as live skills). A repo-
  per-meeting selection UI is the multi-repo follow-up.

---

## Context & Research

### Relevant Code and Patterns

- **Daemon skill contract** (`apps/daemon/src/skills/contract.ts`):
  `Skill`, `SkillResult`, `SkillContext`, `SkillExecutionError`,
  `formatAsSource`. The lift target keeps the same shape but the
  `SkillContext.db` type changes from `better-sqlite3.Database` to
  `SupabaseClient` — that's the load-bearing breaking change.
- **Daemon registry** (`apps/daemon/src/skills/registry.ts`): 48
  lines, lifts almost verbatim. Insertion-order stability matters
  for the classifier tool list.
- **Daemon router classifier** (`apps/daemon/src/router/anthropic-classifier.ts`):
  269 lines, lifts almost verbatim. Already mirrors the
  `AnthropicRelevanceClassifier` and `AnthropicSynthesizer` patterns
  (retry, error taxonomy, tool-use scan of full content array).
- **Daemon router prompt** (`apps/daemon/src/router/prompt.ts`): 387
  lines including worked examples. Lifts verbatim into the engine
  package.
- **Daemon heuristic** (`apps/daemon/src/router/heuristic.ts`): the
  `isToolShaped` regex gate. Lifts verbatim.
- **Daemon pipeline orchestration**
  (`apps/daemon/src/retrieve/pipeline.ts` lines 318-595): the
  "router gate" that launches the classifier in parallel with embed
  + retrieve, then awaits both and merges `toolSource` with
  `cardSources` into the synthesizer's input. The bot-worker's
  `maybeRetrieveAndEmit` will grow a mirror of this section.
- **Daemon live-API skills**
  (`apps/daemon/src/skills/github/{issue_assignees,by_assignee_*,issue_progress,person,live-context,error}.ts`):
  pure HTTP-call skills, lift cleanly with one path adjustment for
  the new import location.
- **Daemon corpus skills** (`apps/daemon/src/skills/github/{count,list,by_author,recently_updated,filter}.ts`):
  these need rewriting. Daemon SQL: `better-sqlite3` with
  `fts_doc_chunks MATCH '"Status open"'` (SQLite FTS5 phrase). Postgres
  equivalent: `doc_chunks.text_fts @@ websearch_to_tsquery('english', '"Status open"')`
  (the GIN-indexed tsvector column from
  `supabase/migrations/20260601000000_corpus_pgvector.sql`). The
  `docs.authors` (jsonb) + `docs.type` columns replace daemon's
  doc-table filter SQL.
- **GitHub HTTP client** (`apps/daemon/src/connectors/github/client.ts`,
  `auth.ts`): the daemon's `GithubClient` + token reader used by
  every live skill. Migrates to the bot-worker without engine
  involvement — it's bot-worker orchestration glue.
- **Bot-worker pipeline insertion point**
  (`apps/bot-worker/src/retrieval.ts` `maybeRetrieveAndEmit`, lines
  ~91-352): the function that already does embed + search + cards
  + synthesis. The skill branch wedges in alongside embed/retrieve.
- **Bot-worker PerMeetingRuntime** (`apps/bot-worker/src/index.ts`
  `interface PerMeetingRuntime`): already gained a `summarizer`
  field this morning (U7 from the rolling-summary plan); a
  `classifier` + `skillRegistry` reference belong here too if they
  need per-meeting state, or stay process-level singletons if not.

### Institutional Learnings

- **Tool-use enforces output shape**: the daemon's classifier uses
  Anthropic tool-use to force `{skillName, args}` JSON shape rather
  than free-form text. The same pattern just shipped for the
  rolling-summary's `emit_meeting_summary` tool.
- **Cacheable prompt prefix**: the daemon's classifier prompt is
  ~4318 tokens (just above the Haiku 4.5 cache floor). Adding skills
  grows the prompt but should stay above the floor; verify after U2.
- **Two-stage relevance gate**: the bot-worker already runs heuristic
  → LLM-classifier-on-ambiguous for relevance (
  `apps/bot-worker/src/retrieval.ts` lines 299-340). The router
  classifier is a separate, parallel concern (`isToolShaped` is the
  router's heuristic; `classifyRelevanceHeuristic` is relevance's).
  Do not conflate them.
- **Pre-production breaking-change posture**: no backward-compat
  hedging. The daemon stays untouched as a parallel implementation;
  the bot-worker version is the new contract. Consolidation later.

### External References

- `docs/brainstorms/router-skills-framework-requirements.md` —
  origin design for the framework.
- `docs/brainstorms/github-live-skills-requirements.md` — origin
  design for the four live-API skills + person resolution.
- `docs/plans/2026-05-29-002-feat-router-skills-framework-plan.md` —
  daemon implementation plan (already shipped).
- `docs/plans/2026-05-29-005-feat-github-live-skills-plan.md` —
  daemon live-skills implementation plan (already shipped).
- Anthropic tool-use docs (already linked in those plans).

---

## Key Technical Decisions

- **Framework code lives in the engine package, skill instances live
  in the bot-worker.** Concretely: `Skill` / `SkillRegistry` /
  `SkillResult` / `SkillExecutionError` / `formatAsSource` /
  `AnthropicRouterClassifier` / `buildRouterSystem` /
  `buildRouterTool` / `isToolShaped` all go in `packages/engine/`.
  The actual `Skill` implementations (`githubCountSkill`,
  `githubIssueAssigneesSkill`, etc.), the `GithubClient`, and the
  per-meeting `SkillRegistry` instantiation live in
  `apps/bot-worker/`. Rationale: skills are app-level orchestration
  (they read tenant-specific config, hit tenant-specific data); the
  framework is infrastructure. Same split the rolling-summary
  feature settled on (`AnthropicSummarizer` in engine,
  `MeetingSummarizerRuntime` in bot-worker).

- **`SkillContext` diverges from the daemon: `db` becomes
  `SupabaseClient`, and a new `orgId: string` field is added.** Two
  changes to the daemon's contract, not one. The `db` type swap is
  the obvious break; `orgId` is the load-bearing multi-tenancy
  field that the daemon never needed (single-user POC). This means
  the lift is NOT verbatim at the contract level — the engine
  package's `SkillContext` differs from the daemon's by these two
  fields, and the daemon will need a parallel change before the
  deferred consolidation can happen. Every U-unit that touches
  `SkillContext` (U1 defines it, U3 builds it, U4 + U6 close over
  it) must reflect this from the start — `orgId` is not a late
  retrofit.

- **Classifier launches in parallel with embed+retrieve, NOT before.**
  The daemon's pipeline (lines 328-345) starts the classifier
  concurrently with embedding so the slower path of the two doesn't
  serialize. Cards still emit synchronously inside the retrieve
  loop, so TTFT on the live page is unchanged regardless of which
  branch wins.

- **Tool result goes at source[0]; cards at source[1..N].** The
  daemon's `runSynthesisAndBroadcast` pattern: when a `toolSource`
  exists, prepend it to the sources array. The synthesizer cites by
  1-indexed position, so [1] is the tool and [2..N] are the cards.
  The existing prompt already handles this (the daemon ships it).

- **Skill registry is process-singleton, not per-meeting.** Skills
  themselves are stateless; the registry holds skill definitions
  built at startup from env vars. Per-meeting state (if any future
  skill needs it) goes in the `SkillContext`, not on the registry.

- **Classifier receives meeting context when the rolling summary
  has fired.** The rolling-summary runtime (just landed in
  docs/plans/2026-05-31-002) already exposes `lastSummary.current_topic`
  + `lastSummary.open_questions` at the `maybeRetrieveAndEmit` call
  site. The classifier's prompt grows to accept an optional
  `context: { current_topic, open_questions }` argument (same shape
  the relevance classifier accepts after U4 of the rolling-summary
  plan). Without context (cold start, daemon path), the classifier
  reads the bare utterance — backwards-compatible behavior. This is
  load-bearing for transcribed-speech utterance shapes: meetings
  produce "how many of those still open?" not "github_count(state:
  open)", and the heuristic gate + classifier prompt were tuned on
  typed input.

- **Issue/PR indexer ports the daemon's `pull-delta.ts` to portal-
  side Inngest.** The corpus skills depend on having issues + PRs
  to query. The daemon already proved this works in SQLite; the
  port writes the same doc + chunk shape to Postgres so the
  corpus-skill SQL can match it. Status + labels stay in chunk text
  for now (matches daemon format; minimal change to U6 corpus skill
  SQL); first-class `state` / `labels` columns are a future schema
  refactor. The indexer ingests issues + PRs + their bodies; comment
  + event timeline ingestion is deferred (see Scope Boundaries) —
  `github_issue_progress` (live API) covers comment-level recall.

- **The corpus skills query Postgres FTS + JSONB, not pgvector.**
  Daemon SQL like `fts_doc_chunks MATCH '"Status open"'` becomes
  Postgres `doc_chunks.text_fts @@ websearch_to_tsquery('english',
  '"Status open"')` against the GIN-indexed tsvector column. Author
  filters move from chunk-text phrase matching to `docs.authors`
  jsonb queries (`@>` or `?` operators).

- **Skill summary-string wording stays byte-identical to the daemon.**
  The synthesizer's prompt was tuned against daemon skill outputs
  (`5 open issues.`, `No matching pull requests.`, etc.). U6's
  Postgres rewrite swaps the SQL underneath but preserves the
  `summarize()`-style string-building functions verbatim. The
  `formatAsSource(result, name, args).text` output — the actual
  surface the synthesizer reads — is what U6 tests byte-equality
  on, not just `SkillResult.summary`.

- **Verbatim prompt move.** The classifier system prompt + worked
  examples come over with zero edits. Mid-lift prompt tuning would
  conflate two changes and forfeit the verification signal "the new
  pipeline behaves the same as the old one on the same inputs."
  Adding the optional `context` field is a structural addition (a
  new section in the user message when context is provided), not a
  rewording of the existing examples.

- **GitHub HTTP client copy-not-import — with a forcing function.**
  The daemon's `apps/daemon/src/connectors/github/client.ts` already
  has GitHub HTTP helpers. Lifting it into the engine package isn't
  right (it's not "engine infrastructure"); importing it cross-app
  from bot-worker → daemon would couple the two apps. A
  `packages/connectors-github/` shared package is the obvious third
  option but adds package overhead for code that's still in flux;
  defer it until the daemon is actually retiring. For now: copy the
  file into `apps/bot-worker/src/skills/github/client.ts` and
  `apps/portal/src/lib/github/` (U5 needs it too), accepting the
  triple-copy temporarily. **Forcing function:** the next bug fix
  to GitHub-client code (auth-token rotation, rate-limit handling,
  any 4xx/5xx taxonomy change) triggers extraction into
  `packages/connectors-github/`. Track via a `docs/solutions/`
  entry post-lift.

- **Framework code lives in the engine package even with a single
  consumer today.** Conventional YAGNI argues against this — the
  bot-worker is the only consumer; the daemon stays put; the
  portal's `/debug/ask` skill integration is deferred. But the
  engine-package location reflects what the abstraction *is*
  (shared retrieval infrastructure used by any meeting-context
  consumer), not what its consumer count is right now. The
  consolidation path back to bot-worker-local is cheap if the
  abstraction proves wrong; the cost of moving from bot-worker to
  engine later is higher. Acknowledged trade-off: `packages/engine/`
  grows API surface for code only one consumer uses for the
  foreseeable future.

---

## Open Questions

### Resolved During Planning

- **Where the framework code lives**: engine package for framework,
  bot-worker for skill implementations (Key Decision above).
- **`SkillContext` shape**: `db: SupabaseClient`, `orgId: string`,
  optional `signal` and `now`. Diverges from daemon by these two
  fields.
- **Whether the daemon implementation is touched**: no — left intact
  as a parallel POC, consolidation deferred.
- **Whether `/debug/ask` gets a skill-aware mode**: no — separate
  plan.
- **Whether the classifier receives rolling-summary context**: YES,
  pulled into U3 (was previously deferred; reframed after
  recognizing transcribed-utterance vs typed-input distribution
  difference).
- **Whether the corpus needs an issue/PR indexer**: YES, U5 ports
  the daemon's `pull-delta.ts` to portal-side Inngest (was
  previously assumed to exist).

### Deferred to Implementation

- **Exact SQL shape for `github_count` etc. on Postgres.** The
  daemon's `apps/daemon/src/skills/github/filter.ts` builds composite
  WHERE clauses; the Postgres translation needs adjacent decisions
  (use generated tsvector column for status/labels via
  `websearch_to_tsquery`, or build dynamic where conditions on
  jsonb columns?). Decide at U6 implementation time after reading
  the daemon's filter.ts closely.
- **Whether per-meeting runtime needs a `classifier` field.** If the
  classifier is a process-singleton (built once from env vars), it
  can live on the bot-worker's `main()` closure like the existing
  `synthesizer` and `relevanceClassifier`. If per-meeting state
  shows up later, move it to `PerMeetingRuntime`.
- **What the bot-worker emits when a skill fails.** The daemon emits
  `skillFailed` as a pipeline event; the bot-worker's broadcast
  shape (Realtime channel + DB) may want a different envelope.
  Decide in U3 — likely a `skillFailed` field on the synthesis
  event payload.
- **Issue/PR indexer trigger strategy.** Options for U5: (a)
  GitHub App webhook (`issues`, `pull_request` events) — push-based,
  fresh within seconds; (b) periodic Inngest cron — pull-based,
  stale up to interval; (c) both (webhook for live updates + cron
  as backstop). The daemon used cron-style `pull-delta.ts` runs.
  Recommend (c) for production but (b) is a viable shipping cut.
  Decide in U5.
- **Chunker output format for U5.** Status + labels phrase format
  in chunk text (e.g., `"Status: open. Labels: bug, p0."`) is the
  daemon's de-facto contract. U5 writes the same shape so U6's SQL
  is straightforward. If U5 chooses a different format (e.g.,
  first-class `state` jsonb on docs), U6's SQL changes accordingly.

---

## Output Structure

This plan creates a new directory hierarchy in two places:

    packages/engine/src/
      router/                          ← NEW
        contract.ts                    ← Classifier, ClassifierResult, ClassifierProviderError
        anthropic-classifier.ts        ← AnthropicClassifier (verbatim name from daemon)
        prompt.ts                      ← buildClassifierSystem, buildClassifierTool, worked examples
        heuristic.ts                   ← isToolShaped
        index.ts                       ← barrel
      skills/                          ← NEW
        contract.ts                    ← Skill, SkillResult, SkillContext, errors, formatAsSource
        registry.ts                    ← SkillRegistry
        index.ts                       ← barrel

    apps/bot-worker/src/
      skills/                          ← NEW
        github/
          client.ts                    ← copied from daemon (HTTP helper)
          auth.ts                      ← copied from daemon (token reader)
          types.ts                     ← copied from daemon
          error.ts                     ← copied from daemon (mapGithubError)
          live-context.ts              ← copied from daemon
          person.ts                    ← copied from daemon (resolvePerson)
          issue_assignees.ts           ← lifted from daemon
          by_assignee_count.ts         ← lifted from daemon
          by_assignee_list.ts          ← lifted from daemon
          issue_progress.ts            ← lifted from daemon
          count.ts                     ← rewritten for Postgres
          list.ts                      ← rewritten for Postgres
          by_author.ts                 ← rewritten for Postgres
          recently_updated.ts          ← rewritten for Postgres
          filter.ts                    ← rewritten for Postgres
          index.ts                     ← skill set assembly

    apps/portal/src/
      lib/github/                      ← NEW
        client.ts                      ← copied from daemon
        auth.ts                        ← reuses portal's existing GH OAuth tokens
        types.ts                       ← copied from daemon
        chunk-issues.ts                ← ported from daemon's pull-delta.ts
      inngest/functions/
        index-github-issues.ts         ← NEW Inngest function (U5)

    packages/engine/package.json       ← MODIFIED: add ./router + ./skills subpath exports
    apps/bot-worker/src/index.ts       ← MODIFIED: build SkillRegistry + classifier at startup
    apps/bot-worker/src/retrieval.ts   ← MODIFIED: router gate + toolSource merge
    apps/portal/src/inngest/index.ts   ← MODIFIED: register the new indexer function

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Data flow at retrieval-tick time

    final utterance arrives
                │
                ├──────────────────────────┬─────────────────────────┐
                ▼                          ▼                         ▼
        isToolShaped()?           classifyRelevanceHeuristic     embed query
        (router gate)             (relevance gate)                    │
                │                          │                          ▼
                │                          │                  vector search RPC
          if tool-shaped                   │                          │
          AND classifier configured        │                          ▼
                ▼                          ▼                    emit cards
        classifier.classify ──── runs in parallel ──── ▶
                │                                       │
        intent='tool'?                                  │
                │                                       │
                ▼                                       │
        skillRegistry.lookup(name)                      │
                │                                       │
                ▼                                       │
        skill.handler(args, ctx)                        │
                │                                       │
                ▼                                       │
        formatAsSource(result) → toolSource             │
                │                                       │
                ▼                                       │
        ┌──────────────────────────────────────────────┘
        ▼
    sources = toolSource ? [toolSource, ...cardSources] : cardSources
    synthesizer.synthesize({utterance, sources, recentContext}) ▶ broadcast deltas

### Classifier launch timing

The classifier promise starts before embed/retrieve. The
`Promise.all` (logically) happens after retrieval-result enrichment
but before the synthesis call:

    t=0       isToolShaped() = true → launch classifier
    t=0       launch embed
    t=~80ms   embed.ok → vector search
    t=~120ms  cards emit synchronously
    t=~250ms  classifier.classify resolves (could be earlier OR later)
    t=~250ms  build sources = [toolSource?, ...cards]
    t=~260ms  synthesizer.synthesize starts

If the classifier resolves AFTER retrieval, the await blocks the
synthesis-trigger but cards have already shipped. If it resolves
BEFORE retrieval, the await is a no-op.

### Skill source / card source coexistence

    rag-only path:    sources = [card1, card2, card3]   →  cite as [1], [2], [3]
    tool-only path:   sources = [toolSrc]               →  cite as [1]
    tool + cards:     sources = [toolSrc, card1, card2] →  cite as [1] (tool), [2], [3] (cards)

The synthesizer's prompt already cites by 1-indexed array position,
so no prompt change is needed.

---

## Implementation Units

- [ ] U1. **Engine: skill contract + registry**

**Goal:** Lift the skill framework's core types and registry into the
engine package so both the bot-worker and (eventually) the daemon
can import the same definitions.

**Requirements:** R1 (foundation).

**Dependencies:** None.

**Files:**
- Create: `packages/engine/src/skills/contract.ts` — `Skill`,
  `SkillResult`, `SkillResultItem`, `SkillResultKind`,
  `SkillContext` (with `db: SupabaseClient`, `orgId: string`,
  optional `signal` + `now`), `SkillUnknownError`,
  `SkillExecutionError`, `SkillExecutionCode`, `AnthropicToolDef`,
  `formatAsSource`, `JsonSchema`, `JsonSchemaProperty`.
- Create: `packages/engine/src/skills/registry.ts` — `SkillRegistry`
  class.
- Create: `packages/engine/src/skills/index.ts` — barrel exports.
- Modify: `packages/engine/package.json` — add `./skills` subpath
  export (mirrors existing `./summarize`, `./relevance`).
- Test: `packages/engine/test/skills/contract.test.ts` —
  `formatAsSource` shape tests, `SkillExecutionError` taxonomy.
- Test: `packages/engine/test/skills/registry.test.ts` — register /
  lookup / list / toToolDefinitions / size, duplicate-name guard.

**Approach:**
- The `Skill.handler` signature stays
  `(args, ctx) => Promise<SkillResult>`. Two changes vs the
  daemon's contract: `SkillContext.db` is typed as `SupabaseClient`
  (imported from `@supabase/supabase-js`), and `SkillContext.orgId`
  is added (required) so corpus queries can scope by tenant. Skills
  that don't use the db (live-API skills) ignore it; skills that
  don't use orgId (live-API skills) ignore it; the contract doesn't
  enforce use of either.
- `formatAsSource` lifts verbatim — it's pure string formatting.
- Errors keep the same `RisezomeError`-based class hierarchy.

**Patterns to follow:**
- `packages/engine/src/summarize/contract.ts` (just shipped) — same
  shape: interfaces + error classes + a barrel.
- `apps/daemon/src/skills/contract.ts` and
  `apps/daemon/src/skills/registry.ts` — direct lift targets.

**Test scenarios:**
- Happy path: `SkillRegistry.register({name: 'x', ...})` then
  `lookup('x')` returns the skill.
- Edge case: `register` called twice with the same name throws
  `'duplicate skill name'`.
- Edge case: `toToolDefinitions()` only emits `{name, description,
  input_schema}` — no extra fields leak into the Anthropic request.
- Happy path: `formatAsSource({kind: 'count', summary: '5 issues.'},
  'github_count', {state: 'open'})` returns
  `{rank: 0, title: 'Tool: github_count({"state":"open"})', text: '5 issues.'}`.
- Edge case: `formatAsSource` with `items` adds a numbered list.
- Edge case: `SkillExecutionError` without `executionCode` defaults
  to `'execution-error'`.
- Edge case: `SkillExecutionError` with `executionCode: 'rate-limit'`
  exposes the code.

**Verification:**
- `pnpm --filter @risezome/engine typecheck` passes.
- `pnpm --filter @risezome/engine test` passes.

---

- [ ] U2. **Engine: router classifier + prompt + heuristic**

**Goal:** Lift the classifier framework — Anthropic call wrapper,
system prompt (with all worked examples), tool-use schema, and the
`isToolShaped` heuristic — into the engine package.

**Requirements:** R1, R2, R7.

**Dependencies:** U1.

**Files:**
- Create: `packages/engine/src/router/contract.ts` — `Classifier`,
  `ClassifyInput`, `ClassifierResult`, `ClassifierUsage`,
  `ClassifierProviderError`, `ClassifierProviderErrorKind`.
- Create: `packages/engine/src/router/anthropic-classifier.ts` —
  `AnthropicClassifier` class. Keep the daemon's export name
  (not `AnthropicRouterClassifier`) so the lift is genuinely
  verbatim at the symbol level — the only changes are the import
  paths.
- Create: `packages/engine/src/router/prompt.ts` —
  `buildClassifierSystem` (with ephemeral cache_control),
  `buildClassifierTool`, ALL worked examples carried over verbatim.
  Keep the daemon's export names; do not rename to `buildRouter*`
  during the lift.
- Create: `packages/engine/src/router/heuristic.ts` — `isToolShaped`
  regex gate.
- Create: `packages/engine/src/router/index.ts` — barrel.
- Modify: `packages/engine/package.json` — add `./router` subpath
  export.
- Test: `packages/engine/test/router/heuristic.test.ts` — port the
  daemon's heuristic tests verbatim.
- Test: `packages/engine/test/router/anthropic-classifier.test.ts` —
  port the daemon's classifier tests; mock fetch returns tool_use
  block with `{skillName, args}`; verify retry/error/abort taxonomy.
- Test: `packages/engine/test/router/prompt.test.ts` — system prompt
  ≥4096 tokens (cache floor), names every skill the daemon registers
  by default, tool name is `pick_skill_or_rag`.

**Approach:**
- The classifier import binds to a `SkillRegistry` passed in at
  `classify()` time (registry is the source-of-truth for available
  tools). The Anthropic request's `tools` field comes from
  `registry.toToolDefinitions()` — keeps the classifier indifferent
  to which skills are loaded.
- The system prompt + worked examples come over byte-identical from
  `apps/daemon/src/router/prompt.ts`. Do not edit the prompt during
  this lift — mid-lift prompt tuning would conflate two changes.
- The `isToolShaped` heuristic is a pure function (regex match);
  zero adaptation needed.

**Execution note:** test-first. Port the daemon's tests before
writing the new files; the verbatim move makes the test diff the
primary evidence the lift didn't drop content.

**Patterns to follow:**
- `packages/engine/src/relevance/anthropic-classifier.ts` — same
  retry/backoff/error shape; the router's classifier is structurally
  identical with a different output schema.
- `apps/daemon/src/router/anthropic-classifier.ts` — direct lift.
- `apps/daemon/src/router/prompt.ts` — direct lift.

**Test scenarios:**
- Happy path: classifier sees a tool-shaped utterance, returns
  `{intent: 'tool', skillName: 'github_count', args: {state: 'open'}}`.
- Happy path: classifier sees an open-ended utterance, returns
  `{intent: 'rag'}`.
- Edge case: model returns text instead of tool_use → classifier
  throws `ClassifierProviderError('bad-request')`.
- Edge case: model returns tool_use with unknown tool name → return
  `{intent: 'tool', skillName: <unknown>, args}` — the caller
  (registry.lookup) is responsible for the unknown-tool error path.
- Error path: 429 with Retry-After → backoff per the existing
  retry shape; eventual `rate-limit` after retries exhausted.
- Error path: AbortSignal mid-call → propagates as AbortError.
- Heuristic: `isToolShaped('how many open issues')` is true.
- Heuristic: `isToolShaped('uh, anyway, so')` is false.
- Heuristic: port the full daemon test file
  (`apps/daemon/test/router/heuristic.test.ts`) so coverage matches.

**Verification:**
- `pnpm --filter @risezome/engine typecheck` passes.
- `pnpm --filter @risezome/engine test` passes.
- Daemon copy stays unchanged — no regressions in
  `pnpm --filter @risezome/daemon test`.

---

- [ ] U3. **Bot-worker: classifier + registry wiring (with rolling-summary context) into the retrieval pipeline**

**Goal:** Instantiate the router classifier + skill registry at
bot-worker startup and wire them into `maybeRetrieveAndEmit` as a
parallel branch alongside embed/retrieve, with `toolSource` merged
into the synthesizer's sources array when present. The classifier
receives `lastSummary.current_topic` + `lastSummary.open_questions`
as optional `context` so short transcribed utterances are classified
in-context.

**Requirements:** R1, R2, R5, R8, R10.

**Dependencies:** U1, U2, U4 (live skills give us something real to
register on first deploy — see Phase 1 collapse below).

**Files:**
- Create: `apps/bot-worker/src/skills/index.ts` — `buildSkillRegistry()`
  factory that reads env vars + assembles the registry. Initially
  reads env vars + builds the live skill set (U4 fills it in;
  U6 appends the corpus skills after U5 lands the indexer).
- Modify: `apps/bot-worker/src/index.ts` — `main()` builds the
  classifier + registry once at startup (process-singleton). Passes
  them into `handleMessage` alongside the existing
  `embedder/synthesizer/relevanceClassifier`.
- Modify: `apps/bot-worker/src/retrieval.ts`
  (`maybeRetrieveAndEmit`):
  - Accept `classifier?: Classifier`, `skillRegistry?: SkillRegistry`
    in args. `lastSummary` is already threaded through from the
    rolling-summary U7 commit (`da35fe8`).
  - After the existing rate-limit gates, if `isToolShaped(utterance)`
    and `classifier !== undefined` and `skillRegistry.size() > 0`,
    launch `classifier.classify({utterance, registry, context: {
    current_topic: lastSummary?.current_topic, open_questions:
    lastSummary?.open_questions ?? [] }})` (with an
    AbortController + timeout the same way `classifyLlmAndDecide`
    does) BEFORE the embed call. Pass `context` only when
    `lastSummary !== null && (current_topic || open_questions
    populated)`; otherwise omit so cold-start behavior matches the
    daemon's typed-input baseline.
  - Continue embed + search + card-emit unchanged.
  - After cards emit, await the classifier promise; on
    `intent: 'tool'`, look up the skill, run its handler with
    `{db, orgId, signal, now}`, format the result as a
    `SynthesisSource`.
  - In the synthesis branch, build `sources = toolSource ?
    [toolSource, ...synthesisSources] : synthesisSources`.
  - Log `classifierStart` / `classifierDone` / `skillStart` /
    `skillDone` / `skillFailed` log lines mirroring daemon
    telemetry. `classifierDone` log includes `hadContext: boolean`
    so context-vs-no-context classification rates can be analyzed
    post-deploy.
- Modify: `packages/engine/src/router/anthropic-classifier.ts` (from
  U2) + `packages/engine/src/router/contract.ts` — extend
  `ClassifyInput` with optional `context: { current_topic?: string;
  open_questions?: readonly string[] }`. When provided, render it
  as a `Meeting context so far:` preamble above the utterance in the
  user message — same structural shape the relevance classifier
  adopted in U4 of the rolling-summary plan
  (`packages/engine/src/relevance/prompt.ts buildRelevanceUserMessage`).
- Test: `apps/bot-worker/test/retrieval-router.test.ts` — mock the
  classifier + a synthetic skill; verify the wire-through (skill is
  invoked when classifier returns tool intent, toolSource lands at
  source[0], classifier failure falls through to RAG-only).
- Test: `packages/engine/test/router/anthropic-classifier.test.ts`
  (extend from U2) — verify `context` is rendered above the
  utterance when provided; bare utterance behavior preserved when
  `context` is absent or empty.

**Approach:**
- The classifier promise runs in parallel with the embed + retrieve
  path (per the daemon's lines 328-345). The await happens after
  card-emit so cards aren't blocked by classifier latency.
- The skill `db` context is the same `SupabaseClient` the retrieval
  loop already uses (`args.db`). Live-API skills will ignore it.
- The `AbortController` for the classifier is independent of the
  retrieval flow's abort logic; on classifier failure (timeout,
  auth, rate-limit), the pipeline continues as RAG-only.
- The `recentContext` plumbed through to the synthesizer (from U3
  of the rolling-summary plan) is unchanged.
- When `toolSource` exists, the synthesis-gate's
  "minSynthesisScore" check is bypassed for the tool-augmented path
  (mirrors daemon lines 611-615): the tool answered, synthesize even
  if no cards cleared the score threshold.

**Patterns to follow:**
- `apps/daemon/src/retrieve/pipeline.ts` lines 318-595 — the
  canonical router-gate + skill-execution + toolSource-merge pattern.
- `apps/bot-worker/src/retrieval.ts` existing
  `classifyLlmAndDecide` — same AbortController + timeout shape for
  the new router classifier call.

**Test scenarios:**
- Happy path (tool intent): mock classifier returns `{intent: 'tool',
  skillName: 'fake_skill', args: {}}`; registry has `fake_skill`
  returning `{kind: 'count', summary: '5 items'}`; verify
  `synthesisSources[0]` is the formatted tool source.
- Happy path (rag intent): mock classifier returns `{intent: 'rag'}`;
  verify no skill runs, synthesizer gets only card sources.
- Happy path (heuristic miss): utterance is "uh anyway"; classifier
  is NOT launched (no `classifierStart` log); embed/retrieve proceed
  normally.
- Edge case (registry empty): classifier exists but registry has
  zero skills; classifier is NOT launched (early-return guard).
- Edge case (unknown skill): classifier returns `{intent: 'tool',
  skillName: 'github_nonexistent'}`; registry.lookup returns
  undefined; `skillFailed` logged with `code: 'unknown-skill'`;
  synthesis proceeds RAG-only.
- Error path (classifier failure): classifier throws
  `ClassifierProviderError('rate-limit')`; pipeline continues
  RAG-only; `classifierError` logged.
- Error path (skill failure): skill handler throws
  `SkillExecutionError('github_count', 'corpus offline', {executionCode: 'execution-error'})`;
  `skillFailed` logged; toolSource is null; synthesis proceeds
  RAG-only.
- Edge case (tool result + no cards): retrieval returns zero hits
  but classifier returns a valid skill result; synthesizer runs
  with `sources = [toolSource]` (single-source synthesis).
- Integration: real bot-worker `handleMessage` flow with a stubbed
  classifier + skill, end-to-end through `persistAndBroadcast`,
  verifies `synthesisStart` event includes citations referencing
  the tool source as [1].

**Verification:**
- `pnpm --filter @risezome/bot-worker typecheck` passes.
- `pnpm --filter @risezome/bot-worker test` passes.
- Manual: run a Recall meeting after U4 lands (Phase 1 collapse —
  U3 and U4 ship together so the first deploy actually exercises
  the wire-through with real live-API skills). "Who is assigned
  to issue 14?" → `classifierStart` → `classifierDone` →
  `skillStart(github_issue_assignees)` → `skillDone` →
  `synthesisStart` with the tool source cited as `[1]`. The
  `classifierDone` log shows `hadContext: true` once the rolling
  summary has fired (after ~30s / 5 utterances).

---

- [ ] U4. **Bot-worker: live-API GitHub skills + HTTP client**

**Goal:** Bring over the four live-API skills + their dependencies
(GitHub HTTP client, auth, types, error mapper, person resolver)
so meetings can answer assignee + progress questions against fresh
GitHub state.

**Requirements:** R3, R5, R6.

**Dependencies:** U1, U2, U3.

**Files:**
- Create: `apps/bot-worker/src/skills/github/client.ts` — copy of
  `apps/daemon/src/connectors/github/client.ts`. HTTP wrapper
  around `fetch` with rate-limit + 4xx/5xx error mapping.
- Create: `apps/bot-worker/src/skills/github/auth.ts` — copy of
  the daemon's token reader (env-var `GITHUB_TOKEN`).
- Create: `apps/bot-worker/src/skills/github/types.ts` — copy of
  `apps/daemon/src/connectors/github/types.ts` (GithubIssue,
  GithubUser, GithubEvent, etc.).
- Create: `apps/bot-worker/src/skills/github/error.ts` — copy of
  `apps/daemon/src/skills/github/error.ts` (`mapGithubError`).
- Create: `apps/bot-worker/src/skills/github/live-context.ts` —
  copy of daemon's `LiveSkillContext` (carries `client + auth +
  repo` config).
- Create: `apps/bot-worker/src/skills/github/person.ts` — copy of
  daemon's `resolvePerson` (try-as-login + user-search fallback).
- Create: `apps/bot-worker/src/skills/github/issue_assignees.ts` —
  copy of daemon skill.
- Create: `apps/bot-worker/src/skills/github/by_assignee_count.ts` —
  copy of daemon skill.
- Create: `apps/bot-worker/src/skills/github/by_assignee_list.ts` —
  copy of daemon skill.
- Create: `apps/bot-worker/src/skills/github/issue_progress.ts` —
  copy of daemon skill.
- Modify: `apps/bot-worker/src/skills/index.ts` — `buildSkillRegistry()`
  checks `UPWELL_GITHUB_REPO` + `GITHUB_TOKEN`; if both present,
  registers the four live skills; logs `github.live.disabled
  reason=no-repo|no-token` otherwise.
- Test: `apps/bot-worker/test/skills/github/person.test.ts` — port
  daemon's tests (mock fetch).
- Test: `apps/bot-worker/test/skills/github/issue_assignees.test.ts` —
  happy path + error path; the assignee-array shape mirrors the
  daemon test.
- Test: `apps/bot-worker/test/skills/github/by_assignee_list.test.ts`
  — happy path + literal-login-miss + search-fallback hit.
- Test: `apps/bot-worker/test/skills/github/issue_progress.test.ts` —
  happy path + timeline event ordering.

**Approach:**
- These are pure HTTP-call skills. They never touch `ctx.db` so the
  Postgres-vs-SQLite difference is irrelevant.
- Import paths change from `'../contract.js'` (daemon) to
  `'@risezome/engine/skills'` (engine package). That's the only
  structural change vs the daemon source.
- The `LiveSkillContext` is built once at startup (in
  `buildSkillRegistry`) and closed over by each skill's
  `buildXxxSkill(ctx)` factory — same pattern as the daemon.
- Per-skill telemetry (R5 in `github-live-skills`) flows through
  U3's `skillStart` / `skillDone` / `skillFailed` log lines.

**Patterns to follow:**
- `apps/daemon/src/skills/github/issue_assignees.ts` and siblings —
  direct copy targets.
- The daemon's test files for each skill — direct port targets.

**Test scenarios:**
- For each of the four skills, port the corresponding daemon test
  file verbatim. The fixtures (canned GitHub JSON responses) carry
  over unchanged.
- Additional scenario: `buildSkillRegistry()` with
  `UPWELL_GITHUB_REPO=undefined` returns an empty registry and logs
  `github.live.disabled reason=no-repo`.
- Additional scenario: `buildSkillRegistry()` with
  `GITHUB_TOKEN=undefined` returns an empty registry and logs
  `github.live.disabled reason=no-token`.
- Additional scenario: both env vars present → registry contains
  four skills with the expected names.

**Verification:**
- `pnpm --filter @risezome/bot-worker typecheck` passes.
- `pnpm --filter @risezome/bot-worker test` passes.
- Manual: in a real Recall meeting with `UPWELL_GITHUB_REPO=owner/repo`
  + `GITHUB_TOKEN=...`, ask "who is assigned to issue 14?" → the
  synthesizer surfaces the current assignees.

---

- [ ] U5. **Portal: GitHub issues + PRs Inngest indexer**

**Goal:** Port the daemon's `apps/daemon/src/connectors/github/pull-delta.ts`
to a portal-side Inngest function so issues + PRs land in the
Postgres corpus (`docs.type IN ('issue', 'pull-request')`,
`doc_chunks.text` carrying `Status: open. Labels: bug.`-style
metadata phrases the corpus skills will FTS against). Without this,
U6's corpus skills have nothing to query.

**Requirements:** R9.

**Dependencies:** None for the indexer itself. U6 depends on U5
landing first; otherwise U6 ships zero-result skills.

**Files:**
- Create: `apps/portal/src/lib/github/client.ts` — copy of daemon's
  HTTP wrapper (`apps/daemon/src/connectors/github/client.ts`).
  Same forcing-function clause as bot-worker's copy: extract into
  `packages/connectors-github/` on next bug fix.
- Create: `apps/portal/src/lib/github/auth.ts` — token source.
  Differs from daemon: reuses the portal's existing GitHub App
  installation tokens (from `app/api/github/install-callback/route.ts`)
  rather than `GITHUB_TOKEN`. The token is per-org-per-installation.
- Create: `apps/portal/src/lib/github/types.ts` — copy of daemon's
  GitHub type definitions.
- Create: `apps/portal/src/lib/github/chunk-issues.ts` — ported
  chunker logic from daemon's `pull-delta.ts` lines 50-130. Writes
  `Status: open. Labels: bug, p0.`-style context line as a chunk
  prefix (matches daemon format byte-for-byte; this is the
  contract U6's FTS depends on).
- Create: `apps/portal/src/inngest/functions/index-github-issues.ts`
  — new Inngest function. Triggered (a) by a cron schedule (every
  30 min) and (b) by `github.installation.repositories.added` or
  `issues`/`pull_request` webhook events when present. Reads
  per-source cursor from `cursors` table; fetches issues + PRs
  since cursor via `GET /repos/{owner}/{repo}/issues?since=...`
  (state: 'all'); chunks each via `chunk-issues.ts`; upserts into
  `docs` + `doc_chunks` + `corpus_chunk_embeddings`; advances
  cursor.
- Modify: `apps/portal/src/inngest/index.ts` — register the new
  function.
- Modify: `apps/portal/app/(authed)/sources/reindex-action.ts` —
  add a "reindex issues" trigger so the manual reindex UI can fire
  the new function alongside the existing repo-tree indexer.
- Test: `apps/portal/test/lib/github/chunk-issues.test.ts` — port
  the daemon's `pull-delta` chunker tests; assert chunk-text format
  matches daemon byte-for-byte for representative issue + PR
  fixtures.
- Test: `apps/portal/test/inngest/index-github-issues.test.ts` —
  mock the GitHub API + Supabase; verify cursor advancement, doc
  upsert, chunk + embedding insert, idempotent re-run (re-running
  with the same cursor doesn't duplicate docs).

**Approach:**
- The daemon's `pull-delta.ts` is the canonical reference. It runs
  in a single process with synchronous SQLite writes; the portal
  port is async (Supabase). Wrap each issue's
  `docs` + `doc_chunks` + `corpus_chunk_embeddings` upsert in a
  single transaction (via Supabase's `.transaction()` or
  rpc-wrapped SQL) so partial writes don't leave a doc without
  its chunks.
- The chunker logic stays as close to the daemon's as possible —
  status line format (`Issue owner/repo#42 — title. Status: open.
  Labels: bug, p0.`), assignees line, header chunk + body chunk
  separation. This is the load-bearing format contract for U6.
- Voyage embedding generation reuses the portal's existing pattern
  (`apps/portal/src/inngest/functions/index-repo.ts` calls
  `embedTexts` from `@risezome/engine/embed`). Same domain
  routing (`text` domain for issue/PR prose).
- Cursor strategy: `cursors.last_updated_at` per source. On each
  run, fetch `GET /issues?since=<last_updated_at>&state=all`,
  process in `updated_at` order, advance the cursor to the
  highest `updated_at` seen.
- Closed issues stay indexed (the daemon does this; "how many
  closed issues last week" is a real query). Reindexing handles
  state transitions via upsert.
- Auth: each source row has an `installation_id` set by the
  GitHub App install flow. Token fetch goes through Octokit's
  installation-token endpoint (or a direct REST call to
  `/app/installations/{id}/access_tokens`). Tokens expire in 1h —
  fetch on demand per Inngest run, cache in-memory for the run.

**Execution note:** test-first on the chunker. The chunker's
output format is the load-bearing contract for U6; lock it before
the indexer plumbing.

**Patterns to follow:**
- `apps/daemon/src/connectors/github/pull-delta.ts` — canonical
  reference for issue + PR chunking + delta logic.
- `apps/portal/src/inngest/functions/index-repo.ts` — portal's
  existing Inngest pattern for cursor + upsert + embedding.
- `apps/portal/app/api/github/install-callback/route.ts` — the
  GitHub App installation auth path.

**Test scenarios:**
- Happy path: fresh source (no cursor) fetches all open + closed
  issues + PRs; writes one `docs` row per issue, header + body
  chunks per doc, embeddings populated.
- Delta path: cursor at `2026-05-01`; only issues updated after
  that date are fetched + written; doc count grows by the delta.
- Chunker format parity: a fixture issue with `state: open,
  labels: ['bug', 'p0'], assignees: ['nathan']` produces a header
  chunk text byte-equal to daemon's `pull-delta.ts` output for
  the same fixture.
- Edge case: zero new issues since cursor → no DB writes, cursor
  unchanged.
- Edge case: issue closed between runs → upsert flips
  `Status: closed` in the chunk text; FTS for "open issues"
  excludes it on the next U6 query.
- Edge case: issue reopened → upsert flips back; symmetrical.
- Error path: GitHub API 401 (auth expired) → function logs
  + fails the run; Inngest retries on next schedule with a
  fresh installation token.
- Error path: Supabase transaction failure mid-write → no
  partial doc state (transaction rolled back); cursor unchanged
  so the next run reprocesses.
- Idempotency: re-running with the same cursor over the same
  issue set produces zero new doc rows.

**Verification:**
- `pnpm --filter @risezome/portal typecheck` passes.
- `pnpm --filter @risezome/portal test` passes.
- Manual: install the GitHub App on a test repo with ~10
  issues + PRs. Trigger reindex. Verify `select count(*) from
  docs where type = 'issue' and org_id = '...'` returns the
  expected count. Sample one row's chunks → confirm the
  `Status:` + `Labels:` phrases appear in `doc_chunks.text`.

---

- [ ] U6. **Bot-worker: Postgres-backed corpus GitHub skills**

**Goal:** Rewrite the four corpus skills (count, list, by_author,
recently_updated) and their filter helper to query the bot-worker's
Postgres corpus (`docs` + `doc_chunks` + `text_fts`) instead of the
daemon's SQLite corpus. By this point U5 has populated the corpus
with issues + PRs so the queries have data to return.

**Requirements:** R4, R5.

**Dependencies:** U1, U2, U3, U5.

**Files:**
- Create: `apps/bot-worker/src/skills/github/filter.ts` — rewritten
  filter builder. Status + labels → `text_fts @@ websearch_to_tsquery
  ('english', '"Status open"')`. Author → `docs.authors @> '[{"login":
  "jamie"}]'::jsonb` OR `docs.authors @> '[{"name": "jamie"}]'::jsonb`
  (exact shape depends on what the portal indexer writes; verify
  during implementation). Type → `docs.type IN ('issue',
  'pull-request')`.
- Create: `apps/bot-worker/src/skills/github/count.ts` — Postgres
  rewrite of daemon's count.ts. Uses `docs` + optional
  `doc_chunks` FTS join when chunk-text filter is needed.
- Create: `apps/bot-worker/src/skills/github/list.ts` — Postgres
  rewrite of daemon's list.ts.
- Create: `apps/bot-worker/src/skills/github/by_author.ts` —
  Postgres rewrite of daemon's by_author.ts.
- Create: `apps/bot-worker/src/skills/github/recently_updated.ts` —
  Postgres rewrite of daemon's recently_updated.ts.
- Modify: `apps/bot-worker/src/skills/index.ts` — append the four
  corpus skills to the registry alongside the live skills (insertion
  order matches the daemon: count first, list, recently_updated,
  by_author, then live skills).
- Test: `apps/bot-worker/test/skills/github/filter.test.ts` —
  filter builder produces the expected SQL fragments + jsonb queries
  for each input shape.
- Test: `apps/bot-worker/test/skills/github/count.test.ts` — against
  a seeded Postgres test DB (or via a Supabase test schema fixture),
  cover all filter combinations.
- Test: `apps/bot-worker/test/skills/github/list.test.ts`,
  `by_author.test.ts`, `recently_updated.test.ts` — same approach.

**Approach:**
- The `SkillContext.db` (now `SupabaseClient`) gives `.from(...)`
  + `.rpc(...)` access. The corpus skills become async
  (`Promise<SkillResult>`) — the daemon's were sync because
  better-sqlite3 is sync. The contract already returns
  `Promise<SkillResult>` so this is a contract-conformance change,
  not a contract change.
- For chunk-text-FTS filters (state + labels), use
  `args.db.rpc('search_corpus_fts', {p_org_id, p_query, p_limit})`
  if the existing RPC fits, or build an inline query via
  `args.db.from('doc_chunks').select('doc_id').textSearch('text_fts',
  '"Status open"', {type: 'websearch'})`. Decide at implementation
  time; both work.
- Distinct-by-doc logic that the daemon does with SQL
  (`COUNT(DISTINCT docs.id)`) becomes an extra reduction in JS or a
  `.select('doc_id').distinct()` via PostgREST.
- The `org_id` scoping is load-bearing for multi-tenancy: every
  query MUST filter by `args.skillContext.orgId` (the new field on
  `SkillContext` defined in U1 — already in place by the time U6
  runs).
- **Lift the daemon's `summarize()` string-builders verbatim, not
  just the SQL.** The daemon's `count.ts:summarize()`, `list.ts`
  summary helpers, etc., produce the exact wording the synthesizer
  was tuned against (`5 open issues.`, `No matching pull requests.`,
  etc.). The Postgres rewrite swaps only the SQL underneath; the
  string-building functions copy over byte-identical. This is the
  load-bearing contract for the synthesizer's existing behavior.

**Execution note:** snapshot the daemon's outputs first, then
implement. Pick ~10 representative fixture inputs per skill (state
+ labels + author combinations, zero-result cases, exact-30-result
truncation cases for `list`). Run the daemon's skill against a
seeded SQLite fixture, capture the full
`formatAsSource(result, skillName, args).text` byte string into
test fixture files. The bot-worker's tests assert byte equality
against these captured strings — the SQL underneath is allowed to
differ, the surface the synthesizer reads is not.

This is **not** "characterization testing" in the
test-against-the-real-daemon sense — the daemon and bot-worker run
in different DBs with different fixtures. It's snapshot-against-
recorded-outputs: the daemon is the spec, the recordings are the
artifact, the bot-worker tests check against the artifact. Pragmatic
trade-off: if the daemon's output is wrong, the bot-worker
preserves the wrong output (until both fix it together). Acceptable
because the daemon's outputs have been through dogfood already.

**Patterns to follow:**
- `apps/bot-worker/src/retrieval.ts` lines 175-220 — existing
  Postgres query patterns from the bot-worker (rpc + from()).
- `apps/daemon/src/skills/github/count.ts`, `list.ts`,
  `by_author.ts`, `recently_updated.ts`, `filter.ts` — the
  characterization source.
- `apps/portal/src/inngest/functions/index-repo.ts` — confirms what
  the corpus chunker actually writes (Status + Labels phrasing).

**Test scenarios:**
- Per-skill: load the snapshot fixture (captured from the daemon).
  Run the bot-worker skill against an equivalent seeded Postgres
  fixture. Assert `formatAsSource(result, name, args).text` byte
  equal to the snapshot. The `text` field is the surface the
  synthesizer reads; that's what must not drift.
- `github_count`: zero results → `"No matching issues."` summary.
- `github_count` with state + labels → returns the matching count,
  hits the FTS index (verify by reading EXPLAIN if the harness
  supports it, otherwise spot-check latency).
- `github_count` with author → uses jsonb `@>` (not chunk-text
  phrase match). Verify a JSONB-shaped fixture.
- `github_list`: top-N issues returned with title + URL + state.
- `github_by_author`: filter by `authors` jsonb; multiple issues
  per author.
- `github_recently_updated`: orders by `updated_at desc` from the
  `docs` table; respects optional `since` arg.
- Edge case: empty corpus (zero docs) → all four skills return their
  zero-result summary without throwing.
- Edge case: org_id scoping — a skill called with org A's context
  cannot see org B's docs (test via two seeded orgs).
- Error path: Supabase RPC returns an error → skill throws
  `SkillExecutionError` with `executionCode: 'execution-error'`.

**Verification:**
- `pnpm --filter @risezome/bot-worker typecheck` passes.
- `pnpm --filter @risezome/bot-worker test` passes.
- Manual: in a real Recall meeting against the seeded corpus, ask
  "how many open issues do we have?" → the synthesizer cites the
  tool source as `[1]` and surfaces the count.
- Manual: "show me PRs from last week" → `github_recently_updated`
  fires with `since` derived from "last week", returns recent PRs.

---

## System-Wide Impact

- **Interaction graph:** The bot-worker's per-utterance pipeline
  gains a third parallel branch (router classifier) alongside the
  existing relevance classifier + vector retrieve. All three
  classifiers share `ANTHROPIC_API_KEY` + the consent gate.
- **Error propagation:** Skill failures, classifier failures, and
  retrieval failures all fall through to the next-most-graceful
  outcome (skill fail → RAG-only; classifier fail → RAG-only;
  retrieval fail → existing error path). No new failure mode blocks
  the pipeline.
- **State lifecycle risks:** The skill registry is process-singleton.
  Skill handlers are stateless or close over the
  `LiveSkillContext` built at startup. No per-meeting cleanup.
- **API surface parity:** `/debug/live-mic` (debug WS surface)
  doesn't gain skill execution in this plan — the lift targets the
  Recall path. Parity is a follow-up plan item.
- **Integration coverage:** The U3 integration tests are the
  primary safety net for the wire-through; the per-skill unit
  tests in U4 + U6 catch skill-internal regressions. Manual
  meeting-level smoke is load-bearing because tests can't
  exercise the real Anthropic + GitHub APIs simultaneously.
- **Unchanged invariants:** The existing vector retrieval + card
  emit + synthesizer prompt all stay exactly as today. The
  `recentContext` plumbing (rolling-summary U3) is unchanged. The
  relevance classifier (rolling-summary U4) is unchanged. The
  synthesis-citation parser is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Postgres FTS phrase queries (`websearch_to_tsquery`) don't match SQLite FTS5 phrase semantics exactly — `"Status open"` may tokenize differently in `english` config than in SQLite's default | U6 snapshot tests catch divergence early. If `websearch_to_tsquery` proves too lossy, drop to `to_tsquery` with explicit `<->` (FOLLOWED BY) operators or fall back to `ilike` chunk-text matching. |
| U5's chunker format diverges from the daemon's — `"Status: open. Labels: bug."` is a load-bearing contract for U6 | U5 starts with chunker tests-as-snapshot of the daemon's `pull-delta.ts` output for representative fixtures. The chunk-text format is locked before the indexer plumbing builds around it. |
| Classifier launches a parallel Anthropic call per tool-shaped utterance, doubling Anthropic cost on those utterances | The `isToolShaped` heuristic gates ~60-80% of utterances out of the classifier per the daemon's deployed shape. Anthropic prompt-caching (system prompt ≥4096 tokens) means cached classifier calls cost ~$0.0001 each. Net per-meeting cost should stay well under $0.50/hr; instrument and confirm post-lift. |
| `isToolShaped` heuristic has high false-negative rate on transcribed conversational speech vs typed input — utterances like "yeah how many of those still open" don't trip the regex even though they're tool questions | Classifier-context (U3) closes part of this gap: short utterances that *do* trip the heuristic get classified in-context. The heuristic itself stays as-shipped from the daemon for now; tuning regex on transcribed speech is a follow-up. Instrument the false-negative rate via "questions the synthesizer's RAG path tried to answer but a tool would've done better" — measurable post-deploy. |
| Two parallel skill implementations (daemon + bot-worker) will drift — and the same is true for the triple-copied GitHub HTTP client (daemon + bot-worker + portal) | Consolidation is explicit deferred work; the forcing function is the next bug fix to GitHub-client code. The first such bug triggers extraction of the client into `packages/connectors-github/`. Track via a `docs/solutions/` entry post-lift listing all current copies. |
| The corpus skills' summary strings are load-bearing for the synthesizer's prompt-tuned behavior (the synthesizer learned outputs like "5 open issues.") | U6's snapshot-tests lock `formatAsSource(result, name, args).text` byte-for-byte to the daemon's outputs. The summarize() string-builders copy over verbatim from daemon. |
| `LiveSkillContext` env-var binding is process-singleton; if a meeting belongs to a different GitHub repo than `UPWELL_GITHUB_REPO`, the live skills answer for the wrong repo | Single-repo constraint from `github-live-skills` D3 carries over — this is a known scope boundary, not a regression. Multi-repo routing is deferred work. |
| The classifier's prompt size grows past Haiku 4.5's cache floor (4096 tokens) breaks caching, raising cost | The daemon's prompt is already ~4318 tokens (above floor). The lift adds a new optional `context` rendering only when context is provided; cold-start calls match the daemon shape exactly. Verify post-U2 with a quick character count. |
| U5's GitHub App token fetch has a 1-hour expiration; Inngest runs that span > 1h could fail mid-run | Token fetch happens at start of each Inngest run, cached in-memory for the run only. Inngest's default function timeout is < 1h; if a run somehow exceeds it, the Inngest retry handles it. |
| The engine-package framework grows API surface for code only one consumer uses today (the bot-worker); deferred portal `/debug/ask` integration may never land | Acknowledged trade-off (see Key Technical Decisions). If consolidation back to bot-worker-local makes more sense after 6 months of single-consumer use, the move is cheap — the framework code is small (~500 LOC total across contract + registry + classifier + heuristic). |

---

## Phased Delivery

### Phase 1: Framework + live-API skills together (U1, U2, U3, U4)

Land the engine-package framework, the bot-worker integration seam,
and the four live-API GitHub skills as a single shipment. The first
deploy exercises the full wire-through with real classifier calls
and real skill execution — no dead-code "empty registry" interim
state.

Real meetings can answer "who's assigned to X" / "what's Sarah
working on" / "progress on #42" / "how many issues does Nathan
have" after this phase. Validates the lift end-to-end against the
live GitHub API.

### Phase 2: GitHub issues + PRs indexer (U5)

Stand up the portal-side Inngest indexer that lands issues + PRs
in the Postgres corpus. No user-visible behavior change in
meetings yet (U6's corpus skills aren't shipped), but the corpus
grows the data U6 needs.

### Phase 3: Corpus skills (U6)

Register the four Postgres-rewritten corpus skills. Real meetings
can answer "how many open issues" / "show me PRs from last week" /
"PRs by Jamie". Closes the requirement gap from the user's
original ask.

Phasing rationale: Phase 1 ships meaningful user value on day one
(four working live-API skills). Phase 2 + 3 split the indexer from
the consumer because they have different risk profiles — the
indexer is bulk-write infrastructure (large blast radius if buggy,
needs careful migration + cursor handling), the consumer is a
read-path skill registration (small, well-tested).

---

## Documentation / Operational Notes

- After Phase 3 lands, add a `docs/solutions/` entry capturing the
  daemon→bot-worker lift pattern + the Postgres FTS phrase-query
  translation — both are reusable for future connector skill lifts
  (Confluence, Linear, Jira).
- Per-skill cost telemetry: the bot-worker's existing structured
  log lines need a `skillStart`/`skillDone` extension that records
  Anthropic + GitHub API latency separately. Otherwise post-deploy
  cost analysis can't distinguish classifier cost from skill cost.
- Inngest indexer parity check (Risk row above) belongs in
  `docs/solutions/github-corpus-chunk-format.md` once verified, so
  future schema changes are forced through a single pinch point.

---

## Sources & References

- **Origin documents:**
  - [docs/brainstorms/router-skills-framework-requirements.md](../brainstorms/router-skills-framework-requirements.md)
  - [docs/brainstorms/github-live-skills-requirements.md](../brainstorms/github-live-skills-requirements.md)
- **Sibling plans (already shipped on the daemon):**
  - [docs/plans/2026-05-29-002-feat-router-skills-framework-plan.md](2026-05-29-002-feat-router-skills-framework-plan.md)
  - [docs/plans/2026-05-29-005-feat-github-live-skills-plan.md](2026-05-29-005-feat-github-live-skills-plan.md)
- **Related code (lift sources):**
  - `apps/daemon/src/skills/contract.ts`, `registry.ts`,
    `github/*.ts`
  - `apps/daemon/src/router/anthropic-classifier.ts`, `prompt.ts`,
    `heuristic.ts`, `contract.ts`
  - `apps/daemon/src/retrieve/pipeline.ts` (lines 315-595)
  - `apps/daemon/src/connectors/github/client.ts`, `auth.ts`,
    `types.ts`
- **Related code (lift targets):**
  - `apps/bot-worker/src/retrieval.ts` (`maybeRetrieveAndEmit`)
  - `apps/bot-worker/src/index.ts` (`main`, `PerMeetingRuntime`)
- **Corpus schema:**
  - `supabase/migrations/20260601000000_corpus_pgvector.sql`
  - `supabase/migrations/20260601100000_search_corpus_rpcs.sql`
- **External docs:** Anthropic tool-use schema enforcement;
  Postgres `websearch_to_tsquery` reference.
