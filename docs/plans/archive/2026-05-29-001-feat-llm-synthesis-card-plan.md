---
title: "feat: LLM synthesis card"
type: feat
status: completed
date: 2026-05-29
origin: docs/brainstorms/llm-synthesis-card-requirements.md
---

# LLM Synthesis Card

## Overview

Add a streaming LLM synthesis card on top of the existing RAG retrieval card stream. Whenever retrieval emits a confident batch, the daemon calls Claude Haiku 4.5 with the top-N snippets plus the triggering utterance and streams a 1-3 sentence focused answer to the HUD over the existing WebSocket. Raw cards continue to ship at retrieval time, unchanged; the synthesis appears above them as a separate streaming card with clickable source citations. Prompt caching with a static system + few-shot prefix is wired from day one to cut TTFT and input cost.

---

## Problem Frame

Today's HUD surfaces raw chunks from issues, code, and docs. Retrieval is fast and accurate but consumption is not — the user has to skim each card to extract the relevant fragment, which is exactly the cognitive cost the product is supposed to eliminate during a live meeting. A focused LLM-synthesized answer compresses N raw snippets into a sentence or two pinned to the top of the stream while raw cards remain below as verifiable sources.

The synthesis is a *lens over the raw cards*, not a replacement. It must:

- Only synthesize from the surfaced sources (no invented facts)
- Cite each claim by source number
- Refuse cleanly (`"No relevant context."`) when sources don't address the utterance
- Stream tokens to the HUD so the answer feels live, not delayed
- Never block raw cards from appearing

See origin: `docs/brainstorms/llm-synthesis-card-requirements.md`.

---

## Requirements Trace

- **R1** — Synthesizer fires only when top retrieval result crosses a confidence threshold (origin D2)
- **R2** — Output is a card on top of the stream with raw cards retained below as sources (origin D1)
- **R3** — Prompt input is the top-N snippets + the single triggering finalized utterance (origin D3)
- **R4** — Provider is Anthropic Claude Haiku 4.5 via the existing consent surface (origin D4)
- **R5** — Raw cards appear immediately; synthesis text streams in token-by-token (origin D5)
- **R6** — Anthropic prompt caching is engaged with a fixed breakpoint between static prefix and dynamic body (origin Prompt Caching section)
- **R7** — Synthesis fails silently to raw-cards-only on any LLM error, timeout, or absent consent (origin Defaults)
- **R8** — Synthesizer only cites the surfaced sources, no facts beyond the snippets (origin Success Criterion #2 + #6)
- **R9** — Synthesis is retracted if a cited source is retracted; not pinnable independently (resolves origin open questions #5, #6)
- **R10** — Cost per typical 30-minute meeting stays ≤$0.05 (origin Success Criterion #5, updated for 4096-token minimum)

---

## Scope Boundaries

- Single-provider integration (Anthropic only) — no pluggable adapter layer
- No multi-turn refinement ("explain more about source 2"); synthesis is single-shot
- No persisted synthesis cache across meetings; in-meeting cache only
- No user-facing settings for verbosity or style; fixed prompt for v1
- No cross-meeting synthesis ("we discussed this last week")
- No Citations API; raw `[N]` citation strings parsed post-hoc
- No `tool_use` or thinking modes; pure text completion

### Deferred to Follow-Up Work

- Provider abstraction layer (Gemini / OpenAI / local Ollama adapter): separate PR once a second provider is needed
- Privacy-mode killswitch UI in the HUD: follows Phase 2 privacy-mode work (origin Defaults reference)
- Surfacing-quality telemetry dashboards: feeds into plan U24 (separate plan)
- Confidence threshold calibration against hand-graded queries: separate calibration exercise post-launch, threshold env-tunable until then

---

## Context & Research

### Relevant Code and Patterns

- **Retrieval pipeline insertion seam**: `apps/daemon/src/retrieve/pipeline.ts` `RetrievalPipeline.#evaluate()` — after the raw-card emit loop completes, fire-and-forget synthesis call. The pipeline already iterates results in rank order and assigns `rank`; `r.score` is the RRF score and `rank === 1` is the top match.
- **External-provider client pattern**: `apps/daemon/src/embed/voyage.ts` — constructor takes `{apiKey, baseUrl?, model?, fetchImpl?, maxRetries?, onUsage?, onRetryWait?}`; defaults as named consts; `fetchImpl` injection is the test seam; `EmbeddingRateLimitError extends UpwellError` with code; retry loop honors `Retry-After`.
- **Streaming WS client pattern (for shape, not code)**: `apps/daemon/src/transcribe/deepgram.ts` — typed EventEmitter, factory injection, reconnect/backoff. Anthropic is HTTP-streaming via SSE not WS, but the typed-event pattern carries over.
- **Card/WS broadcast wiring**: `apps/daemon/src/cli/serve.ts` lines 162-185. New events extend `CardBusEvents` (line 34); `pipeline.on(...)` bridges into the bus; `cardBus.on(...)` JSON-stringifies and broadcasts.
- **HUD discriminated-union message contract**: `apps/hud/src/types.ts` `ServerMessage` — hand-mirrored to daemon's `CardEvent`; new event types added in both places with identical field names.
- **HUD card DOM construction**: `apps/hud/src/sidebar.ts` `#buildCardElement` — `provisional` class is the existing precedent for "this card is different"; mirror with `synthesis` class.
- **Consent module**: `apps/daemon/src/cli/consent.ts` `SUPPORTED_PROVIDERS` already lists `anthropic`; consent stored in SQLite `consent` table. **No runtime check helper exists yet** — this plan introduces `hasConsent(db, provider)` as a new helper. `ConsentRequiredError` already exists in `apps/daemon/src/embed/contract.ts`.
- **Env loader**: `apps/daemon/src/cli/load-env.ts` walks from cwd up to workspace root; access via `requireEnv` / `optionalEnv` / `envInt` in `apps/daemon/src/cli/util.ts`. New keys follow the same convention.
- **Test patterns**:
  - HTTP+streaming: build a `Response` whose body is a `ReadableStream` emitting SSE chunks; pass via `fetchImpl`. Pattern at `apps/daemon/test/embed/voyage.test.ts`.
  - HUD DOM: `// @vitest-environment happy-dom`, `document.body.innerHTML = ...`, instantiate `Sidebar`, assert on selectors.

### Institutional Learnings

`docs/solutions/` does not exist yet — no prior learnings. The Anthropic prompt-caching shape and the synthesis WS protocol are strong candidates for the first entries once this lands (separate from this plan).

### External References

Synthesized from `platform.claude.com/docs` and supporting RAG-synthesis best-practice surveys.

- Messages API request shape & streaming SSE events: `message_start` → `content_block_start` → `content_block_delta` (`text_delta`) → `content_block_stop` → `message_delta` → `message_stop`. Usage metadata lands on `message_start.message.usage` and (cumulatively) on `message_delta.usage`.
- **Prompt caching:** `cache_control: { type: "ephemeral" }` is a field on a content block (typically the last block of `system`), not on the request root. 5-minute TTL refreshed for free on every hit. Max 4 breakpoints per request. **Haiku 4.5 minimum cacheable prefix: 4096 tokens** (this is the binding design constraint; less than that and caching silently no-ops). Cache hit/miss reported as `cache_read_input_tokens` / `cache_creation_input_tokens` separately from `input_tokens` (which counts uncached only).
- **Error model:** 429 with `retry-after` header, 401 auth, 400 invalid, 500/504/529 transient. `cache_read_input_tokens` does NOT count toward Haiku 4.5's ITPM — caching directly buys rate-limit headroom.
- **Abort:** `AbortController.signal` flows through `fetch` to the underlying `ReadableStream`; calling `abort()` rejects the reader with `AbortError`.
- **RAG synthesis prompting** (cross-source synthesis):
  - Refusal sentinel reduces hallucination meaningfully — Anthropic's official guidance
  - `[N]` integer citation format is robust (regex-parseable, single-token) and validatable post-hoc
  - 5-7 few-shots covering 1-2 refusal cases is the recommended shape
  - `max_tokens` ceiling layered on top of natural-language length constraint is most reliable
- **HUD streaming UX:** TTFT target <500ms via cached prefix; trailing block cursor `▊` during stream; source chips render eagerly per `[N]` token so peripheral vision catches motion before prose lands.

---

## Key Technical Decisions

- **Raw fetch over `@anthropic-ai/sdk`** — matches existing Voyage/Deepgram patterns, the API surface used (single POST + SSE parse + AbortController) is ~150 lines, and the SDK's main benefit (tools, thinking, batch) is not in scope here. Adopt SDK later if those become needed.
- **Synthesis is a separate WS event family, not a `CardEvent` variant** — discriminated events `synthesisStart` / `synthesisDelta` / `synthesisDone` / `synthesisError` / `synthesisRetracted`. Keeps the existing `card`/`cardUpdated`/`cardRetracted` contract unchanged and gives the HUD a clean rendering branch. Resolves origin open question #3.
- **Synthesis is not pinnable; cited sources are** — the synthesis is a derived view. Pinning the underlying raw card is how a user keeps the source visible. Resolves origin open question #5.
- **Cited-source retraction cascades to synthesis** — if `cardRetracted` fires on any source the synthesis cited, the daemon emits `synthesisRetracted` for that synthesis. Cleaner trust semantics than letting a synthesis cite a retracted card. Resolves origin open question #6.
- **AbortController per session** — `RetrievalPipeline` holds the in-flight synthesis controller. A new debounced flush aborts the previous synthesis before starting a new call. Avoids stale streaming text from a superseded retrieval.
- **Confidence threshold provisional default = 0.025 RRF, env-tunable** — that score roughly corresponds to top rank in at least one ranker (`1/(60+1) ≈ 0.016` plus enough lift from the second ranker to clear). The value is a starting point pending calibration against hand-graded queries; the calibration exercise is deferred. Env: `UPWELL_SYNTHESIS_MIN_SCORE`.
- **Synthesis gate evaluates the EMITTED top card AND requires at least one newly emitted card this flush** — important because `pipeline.ts` skips already-surfaced docs in `MeetingSession.hasSurfaced`. If we gated on the raw retrieval result instead, repeated debounced flushes on the same window would re-synthesize forever even though no new cards shipped. The gate is: `(emittedCards.length > 0) && (emittedCards[0].score >= minSynthesisScore)`.
- **`AbortController` is owned by `RetrievalPipeline`, not the synthesizer** — the contract receives `AbortSignal` (not a controller). The pipeline mints one controller per synthesis call, stores it on `#currentSynthesisController`, and aborts the previous one before scheduling the next. The synthesizer threads the signal into `fetch` but never creates a controller of its own.
- **Active-synthesis state lives in `MeetingSession`** — `Map<synthesisId, {citedCardIds, sourceCardIds, controller, startedAt}>`. The retract cascade in U4 reads this map. Single source of truth for the in-flight synthesis and its cited sources.
- **`ANTHROPIC_API_KEY` is `optionalEnv`, not `requireEnv`** — absent key → synthesis silently disabled, raw cards behave as today. The daemon must not refuse to start because synthesis isn't configured.
- **Refusal output = fixed sentinel `"No relevant context."`, surfaced as `synthesisError` with code `refused`** — locked: the pipeline does NOT emit `synthesisDone` for a refusal. It emits `synthesisError {code: 'refused'}` instead so the HUD has one consistent removal path for both genuine errors and refusals. Avoids ambiguous "empty stream means refusal vs network drop" and keeps the HUD's event handling table small.
- **Citation format = bracketed integer `[N]`** — parsed post-hoc by `/\[(\d+)\]/g`; invalid `[N]` (out of range) is dropped silently before broadcasting.
- **Cache breakpoint on the last `system` block** — system + few-shot examples live in one or more `system` text blocks; `cache_control: { type: "ephemeral" }` goes on the last of them. User message holds the variable utterance + numbered sources.

---

## Open Questions

### Resolved During Planning

- **Q1 (origin): WS protocol shape for streaming partials.** New `synthesis*` discriminated event family; not a `cardUpdated` extension.
- **Q3 (origin): synthesis card type in corpus.** Separate `SynthesisEvent` family; not a `CardEvent` variant.
- **Q5 (origin): pin behavior.** Synthesis is not pinnable; user pins the underlying source card.
- **Q6 (origin): retract cascade.** Cited-source retraction triggers `synthesisRetracted`.
- **Cache breakpoint placement.** On the last `system` text block (not request root).
- **Refusal contract.** Fixed sentinel string `"No relevant context."`.
- **Citation format.** Integer `[N]` matching 1-indexed source position; post-hoc validated.
- **Default confidence threshold.** 0.025 RRF, env-tunable via `UPWELL_SYNTHESIS_MIN_SCORE`.

### Deferred to Implementation

- **Exact system prompt wording.** Tone, refusal language, citation directive. To be drafted in U2 and tuned in dogfooding.
- **Exact 5-7 few-shot example pairs.** Must collectively push the cached prefix to ≥4096 tokens. U2 includes a pre-flight token-count proxy (≥16k chars conservatively); U7 telemetry verifies via `cache_creation_input_tokens > 0` on the first live call; if the proxy underestimates and cache silently no-ops, expand the few-shot block.
- **Confidence threshold calibration.** 0.025 is the provisional starting point; tuning requires a hand-graded query set against the corpus. Deferred to a separate post-launch exercise.
- **Citation chip visual design.** Rough shape (small clickable chip with `[N]` and source title) decided in U6; specific border/padding/animation tuned during implementation.
- **Display window after `synthesisDone`.** Best-practice guidance is 8-15s before fade; exact number tuned during dogfood.
- **Streaming chunk batch size.** Whether to forward every `text_delta` over WS or batch within a frame (~16ms). Tuned during implementation for perceived smoothness.

---

## Implementation Units

- [x] U1. **Anthropic synthesizer contract + streaming client + SSE test utility**

**Goal:** Stand up a typed `Synthesizer` interface and an `AnthropicSynthesizer` implementation that posts to Messages API, parses SSE, yields chunks via `AsyncIterable`, accepts an externally owned `AbortSignal`, and handles 429 / 5xx / transient errors with retry+backoff. Includes the `sseResponse(events)` test helper required to author streaming tests — the existing `voyage.test.ts` `new Response(string)` pattern does not cover chunked bodies.

**Requirements:** R4, R5, R6, R7

**Dependencies:** none

**Files:**
- Create: `apps/daemon/src/synthesize/contract.ts`
- Create: `apps/daemon/src/synthesize/anthropic.ts`
- Create: `apps/daemon/test/_helpers/sse-response.ts` (returns `Response` whose body is a `ReadableStream` emitting controlled SSE chunks)
- Create: `apps/daemon/test/synthesize/anthropic.test.ts`

**Approach:**
- `Synthesizer` interface: `synthesize(input: SynthesisInput, signal?: AbortSignal): AsyncIterable<SynthesisChunk>`. Chunk types: `start { synthesisId, model, usage? }`, `textDelta { delta }`, `done { stopReason, usage }`, `error { code, message, retryAfterMs? }`. `synthesisId` minted by the client.
- `SynthesisInput`: `{ utterance: string, sources: { rank: number, title: string, text: string }[], maxTokens?: number, temperature?: number }`.
- `AnthropicSynthesizer` constructor: `{ apiKey, baseUrl?, model?, maxTokens?, temperature?, fetchImpl?, onUsage? }` — mirrors `VoyageEmbedder`. Defaults exported as named consts (`DEFAULT_ANTHROPIC_BASE`, `DEFAULT_ANTHROPIC_MODEL='claude-haiku-4-5'`, `DEFAULT_MAX_TOKENS=150`, `DEFAULT_TEMPERATURE=0.2`).
- Request: `POST {base}/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Body: `{ model, max_tokens, stream: true, system: [{...,cache_control}], messages: [...] }`. The system blocks come from U2's `buildSystemPrefix()`; this unit just inserts them.
- SSE parser: chunked `ReadableStream` → `TextDecoderStream` → line buffer split on `\n\n` blocks → parse `event:`/`data:` pairs → dispatch on `data.type`. Filter out `ping`. Surface `error` events as terminal errors.
- Error taxonomy in contract.ts: `SynthesisProviderError`, `SynthesisRateLimitError` (carries `retryAfterMs`). Reuse `ConsentRequiredError` from `embed/contract.ts`.
- Retry loop: only on 429 / 500 / 504 / 529 / network errors; respect `retry-after` exactly; otherwise exponential backoff + jitter; max 3 retries.
- AbortSignal: the contract receives `signal?: AbortSignal` — the caller (pipeline) owns the controller. Thread `signal` through `fetch({...,signal})`; catch `DOMException` with `name === 'AbortError'` and re-throw as a sentinel so the caller can distinguish abort from error.
- SSE test helper (`apps/daemon/test/_helpers/sse-response.ts`): factory `sseResponse({events: Array<{event?: string, data: unknown}>, status?: number, headers?: Record<string,string>}): Response`. Uses the global `ReadableStream` constructor (Node 22 web-stream global, NOT `node:stream/web`) so it interoperates with Node 22's undici-based `fetch`. Used by every streaming test in this unit and reused by future streaming-API tests.

**Patterns to follow:**
- `apps/daemon/src/embed/voyage.ts`: constructor option shape, `fetchImpl` default, 429 detection + `Retry-After` parsing, retry+backoff loop, error class hierarchy
- `apps/daemon/src/transcribe/deepgram.ts`: typed EventEmitter pattern (informs the chunk type union)

**Test scenarios:**
- Happy path: mock fetch returns a `ReadableStream` emitting `message_start` → 3× `content_block_delta` → `message_delta` → `message_stop`. Iterator yields `start`, three `textDelta`s, `done`. Final usage merges cumulative `message_delta.usage`.
- Edge case — cache hit reported: `message_start.message.usage.cache_read_input_tokens > 0`. Iterator's first chunk includes `usage` with that field present.
- Edge case — `ping` events: mid-stream ping events are silently dropped, iterator output unaffected.
- Edge case — `cache_creation_input_tokens > 0`: cache miss on first call. Test the same chunk-yielding behavior, only differs in usage metadata.
- Error path — 429 with `Retry-After: 2`: client retries after exactly 2000ms; second attempt succeeds. Assert `onRetryWait` is called with `waitMs = 2000 + jitter`.
- Error path — 401 invalid key: thrown as `SynthesisProviderError` with code `auth-error`; **no retry**.
- Error path — 400 malformed: thrown as `SynthesisProviderError`; **no retry**.
- Error path — mid-stream `error` event with `overloaded_error`: terminal, surfaces as `SynthesisProviderError` with code `overloaded`.
- Edge case — abort during stream: caller invokes `controller.abort()` after 2 deltas; iterator throws `AbortError` (sentinel); usage from `message_start` still accumulated.
- Error path — network error before SSE established: `fetch` rejects with `TypeError`. Surfaces as `SynthesisProviderError` with code `network-error` after retries exhausted.
- Integration — actual `cache_control` field is present on the last `system` block in the outgoing request body (assert via captured fetch payload).

**Verification:** All test scenarios pass. Manual smoke: with a real `ANTHROPIC_API_KEY`, calling `synthesize()` with a sample utterance + sources yields a streaming answer within ~1-2s TTFT.

- [x] U2. **Cacheable prompt assembly + citation parsing**

**Goal:** Build the cacheable system prefix (system prompt + 5-7 few-shot examples) sized ≥4096 tokens for Haiku cache eligibility, the dynamic user-message body (utterance + numbered sources), and the post-hoc citation extractor / refusal-sentinel detector. Also export the `REFUSAL_SENTINEL` constant — U4 consumes it for the refusal-detection branch.

**Requirements:** R3, R6, R7, R8

**Dependencies:** U1 (uses contract types only; U2 produces the system blocks U1 inserts into the request — U1 does not depend on U2's text constants)

**Files:**
- Create: `apps/daemon/src/synthesize/prompt.ts`
- Create: `apps/daemon/test/synthesize/prompt.test.ts`

**Approach:**
- Module-level constants — `SYSTEM_PROMPT` (string), `FEW_SHOT_EXAMPLES` (array of `{utterance, sources, answer}`). System prompt instructs: only use provided sources, every sentence cites a numbered source, refusal sentinel `"No relevant context."`, 1-3 sentences, no preamble. Few-shots: 5-7 examples including 1-2 refusal cases, varied source counts.
- `buildSystemPrefix(): TextBlockParam[]` — returns one or more `{type: 'text', text}` blocks, last one marked `cache_control: {type: 'ephemeral'}`. Combined text must measure ≥4096 tokens (approximation: ≥16k chars conservatively; verify with `cache_creation_input_tokens` on first live call).
- `buildUserMessage(utterance: string, sources: SynthesisSource[]): MessageParam` — formats as `Utterance: <text>\nSources:\n[1] <title>\n<text>\n\n[2] <title>\n<text>\n...`.
- `parseSynthesisOutput(text: string, sourceCount: number): { text: string, citations: number[], isRefusal: boolean }` — extracts `[N]` with `/\[(\d+)\]/g`, validates each `N <= sourceCount`, drops invalid silently, detects exact-match refusal sentinel.
- `REFUSAL_SENTINEL` exported const.

**Patterns to follow:**
- N/A — net-new module. No existing prompt-assembly precedent in the repo.

**Test scenarios:**
- Happy path — `buildUserMessage` formats utterance + 3 sources into the expected layout (assert exact string).
- Happy path — `parseSynthesisOutput("The view is planned [1] but not built [2].", 3)` returns `{text, citations: [1, 2], isRefusal: false}`.
- Edge case — citation out of range: `parseSynthesisOutput("Per [5].", 3)` returns `{citations: []}` (invalid `[5]` dropped); the malformed citation may or may not be stripped from text but the citation list is clean.
- Edge case — duplicate citations: `parseSynthesisOutput("Per [1] and [1] again.", 3)` returns `{citations: [1]}` (deduped).
- Edge case — no citations: `parseSynthesisOutput("Just text.", 3)` returns `{citations: []}` — implementer surfaces this as a post-hoc quality signal but not an error.
- Refusal — `parseSynthesisOutput("No relevant context.", 0)` returns `{isRefusal: true}`.
- Refusal — exact match only: `"No relevant context. Maybe try again."` is NOT a refusal (must be exact-match against `REFUSAL_SENTINEL`).
- Integration — `buildSystemPrefix()` produces block(s) where the LAST block has `cache_control: {type: 'ephemeral'}` and no other block does.
- Integration — combined system-prefix text length is ≥16000 characters (proxy for ≥4096 tokens; tightened by U7 telemetry once we measure live).

**Verification:** All scenarios pass. The token-length proxy and the live `cache_creation_input_tokens` check in U7 together prove caching engages.

- [x] U3. **Runtime consent check helper**

**Goal:** Add `hasConsent(db, provider)` helper that reads the existing `consent` SQLite table. Synthesis call sites use it to short-circuit cleanly when the user hasn't granted `anthropic` consent.

**Requirements:** R4, R7

**Dependencies:** none

**Files:**
- Create: `apps/daemon/src/cli/consent-store.ts`
- Create: `apps/daemon/test/cli/consent-store.test.ts`
- Modify: `apps/daemon/src/cli/consent.ts` (export the table-row shape if not already exported)

**Approach:**
- Single named export: `hasConsent(db: DatabaseType, provider: ConsentProvider): boolean`. Synchronous (better-sqlite3 is sync).
- Reuses the same `consent` table schema (`provider_id` column) the CLI grant/revoke commands already write to. No schema change.
- Existing revoke is `DELETE FROM consent WHERE provider_id = ?` (no tombstone) — the helper is therefore the trivial `SELECT 1 FROM consent WHERE provider_id = ? LIMIT 1`.
- The helper accepts an externally-owned `db` handle from `serve.ts` and **does not** use the existing `withDb` wrapper (which opens/closes its own connection — calling it mid-meeting against the long-lived `serve.ts` connection would be catastrophic).
- No I/O beyond the prepared-statement read.

**Patterns to follow:**
- Existing `consent.ts` for the SQL shape
- Other small helpers in `apps/daemon/src/corpus/query.ts` for the prepared-statement pattern

**Test scenarios:**
- Happy path — grant for `anthropic` exists → `hasConsent(db, 'anthropic')` returns `true`.
- Edge case — no consent row → `hasConsent(db, 'anthropic')` returns `false`.
- Edge case — grant for `voyage` exists but not `anthropic` → `false`.
- Edge case — revoked consent (whatever the existing revoke semantics are: delete or tombstone) → `false`. Verify against actual current behavior of `consent revoke`.
- Integration — `hasConsent` reads the same table written by `consent grant <provider>` CLI command (test inserts via grantConsent, asserts via hasConsent).

**Verification:** All scenarios pass; pipeline integration in U4 demonstrates the gate working end-to-end.

- [x] U4. **Pipeline integration: gate, fire, stream, cite, retract**

**Goal:** Hook the synthesizer into `RetrievalPipeline.#evaluate()` after raw cards emit. Gate on top-card RRF score and consent. Track in-flight `AbortController` per session and abort on the next schedule. Emit new `synthesisStart` / `synthesisDelta` / `synthesisDone` / `synthesisError` / `synthesisRetracted` events. Validate citations post-hoc. Cascade retraction when a cited source retracts.

**Execution note:** Test-first for the gating and abort semantics — those are pure-pipeline logic with clear input/output contracts. The streaming wiring can follow after the gate/abort tests pin behavior.

**Requirements:** R1, R2, R3, R5, R7, R8, R9

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `apps/daemon/src/retrieve/pipeline.ts`
- Modify: `apps/daemon/src/retrieve/contract.ts` (new event types in `RetrievalPipelineEvents`)
- Modify: `apps/daemon/src/meeting/session.ts` (add `recordSynthesis` / `clearSynthesis` / `getActiveSynthesis` / `getSynthesesCiting` methods; `#syntheses: Map<synthesisId, {citedCardIds, sourceCardIds, controller, startedAt}>`)
- Modify: `apps/daemon/test/retrieve/pipeline.test.ts`
- Modify: `apps/daemon/test/meeting/session.test.ts`

**Approach:**
- Extend `RetrievalPipelineOptions` with `synthesizer?: Synthesizer`, `consentCheck?: () => boolean`, `minSynthesisScore?: number` (default 0.025), `synthesisTopN?: number` (default 3), `synthesisMaxTokens?: number`.
- Extend `RetrievalPipelineEvents` with `synthesisStart`, `synthesisDelta`, `synthesisDone`, `synthesisError`, `synthesisRetracted`.
- After the existing raw-card emit `for` loop in `#evaluate`, collect emitted cards into a local array. The gate is: `(emittedCards.length > 0) && this.#synthesizer && this.#consentCheck() && (emittedCards[0].score >= this.#minSynthesisScore)`. The "must have emitted ≥1 new card" condition is important — `pipeline.ts` skips already-surfaced docs, so repeated flushes on the same window could otherwise re-synthesize on a stale top result. If all conditions pass, call `void this.#maybeSynthesize(topCards, windowText.text, traceId, utteranceId)`. **Do not `await`** — raw cards already shipped.
- `#maybeSynthesize` mints `synthesisId`, builds input, creates `AbortController` (`signal` passed to synthesizer's `synthesize()` call), aborts the prior `MeetingSession.getActiveSynthesis()?.controller`, records the new active synthesis via `session.recordSynthesis(synthesisId, sourceCardIds, controller)`, emits `synthesisStart`, then `for await` over the synthesizer iterator. On each `textDelta` chunk, emit `synthesisDelta`. On `done`, run `parseSynthesisOutput` — if `isRefusal`: emit `synthesisError {synthesisId, code: 'refused'}` (NOT `synthesisDone`); else emit `synthesisDone {synthesisId, citations}` with **only the valid citations** (out-of-range `[N]` are dropped per U2's parser). On either terminal event: `session.clearSynthesis(synthesisId)`.
- `#schedule` calls `session.getActiveSynthesis()?.controller.abort()` before clearing the debounce timer.
- Retract cascade: when `cardRetracted` fires for a `cardId`, call `session.getSynthesesCiting(cardId)` — for each matching `synthesisId`, emit `synthesisRetracted {synthesisId, reason: 'source-retracted'}` and `session.clearSynthesis(synthesisId)`.

**Patterns to follow:**
- Existing `#evaluate` shape (debounce → flush → evaluate)
- `RetrievalTrace` emission pattern for the post-emit telemetry block
- `MeetingSession` for "this synthesis cited these cardIds" tracking — extend with `recordSynthesis(synthesisId, citedCardIds[])` and `getSynthesesCiting(cardId): SynthesisId[]`

**Test scenarios:**
- Gate — top score 0.030 (≥0.025): synthesizer is invoked.
- Gate — top score 0.020 (<0.025): synthesizer is NOT invoked; no `synthesisStart` emitted.
- Gate — no consent: synthesizer is NOT invoked even if score is high; no error event, silent skip (logged at U7).
- Gate — repeated flush on same window with no new emitted cards (all results already surfaced): synthesizer is NOT invoked, even though retrieval results may be high-scoring. Prevents cost runaway from duplicate context.
- Happy path — synthesizer yields start + 3 deltas + done: pipeline emits `synthesisStart` (with `sourceCardIds`), three `synthesisDelta` events with the delta text, one `synthesisDone` with **only valid citations** parsed from the concatenated text (out-of-range `[N]` excluded).
- Edge case — refusal sentinel: synthesizer yields a single `textDelta` that exactly matches `"No relevant context."` then `done`. Pipeline emits `synthesisStart`, the delta, then `synthesisError` with code `refused` (no `synthesisDone`). HUD test in U6 covers the visual suppression.
- Edge case — abort on new schedule: synthesizer is mid-stream when `#schedule` runs again. Pipeline aborts the controller. The first synthesis never emits `synthesisDone`. The new schedule fires a second synthesizer call.
- Error path — synthesizer throws `SynthesisProviderError`: pipeline emits `synthesisError` with the error's code/message. Raw cards already emitted are unaffected.
- Error path — synthesizer throws `SynthesisRateLimitError` after retries exhausted: same as above; `synthesisError` with `rate-limited` code.
- Integration — retract cascade: emit `cardRetracted` for a source the current synthesis cited. Pipeline emits `synthesisRetracted` with the `synthesisId`. If the retracted card was NOT cited, nothing is emitted.
- Integration — no `await` on synthesis: assert that `#evaluate` returns before the synthesizer's first chunk is consumed (use a synthesizer mock with a deliberate delay).

**Verification:** All scenarios pass. Pipeline tests previously green still green. The synthesizer mock can drive end-to-end behavior without an Anthropic key.

- [x] U5. **Serve.ts wiring + env config + WS broadcast bridge**

**Goal:** Instantiate the `AnthropicSynthesizer` from env, pass it (with the consent gate closure) into `RetrievalPipeline`, extend `CardBusEvents` and broadcast the new synthesis events over the existing `/ws/events` WebSocket.

**Requirements:** R4, R5, R7, R10

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `apps/daemon/src/cli/util.ts` (add `envFloat(name, fallback)` helper — parallels `envInt`, validates via `Number.isFinite`)
- Modify: `apps/daemon/src/cli/serve.ts`
- Modify: `apps/daemon/test/cli/util.test.ts` (cover `envFloat`: valid float, invalid input rejected, missing-with-fallback, negative-allowed-but-NaN-rejected)
- Modify: `apps/daemon/test/cli/serve.test.ts` (if it exists; otherwise smaller env-driven unit test in `synthesize/`)
- Modify: `.env.example`

**Approach:**
- Add `envFloat(name, fallback)` to `util.ts` — bare `Number("0.025")` silently produces `NaN` on typos like `"0,025"` (European decimal), which would make `r.score >= NaN` always false and disable the gate permanently. The helper validates via `Number.isFinite` and falls back on invalid input. Mirrors `envInt`'s pattern.
- Env reads:
  - `ANTHROPIC_API_KEY` — `optionalEnv`; absent → synthesizer is `undefined`, pipeline skips silently
  - `ANTHROPIC_MODEL` — `optionalEnv`, default `claude-haiku-4-5`
  - `UPWELL_SYNTHESIS_MIN_SCORE` — `envFloat`, default `0.025`
  - `UPWELL_SYNTHESIS_TOP_N` — `envInt`, default `3`
  - `UPWELL_SYNTHESIS_MAX_TOKENS` — `envInt`, default `150`
- If `ANTHROPIC_API_KEY` present: `const synthesizer = new AnthropicSynthesizer({apiKey, model, maxTokens, onUsage: ...})`. Else `undefined`.
- `consentCheck` closure: `() => hasConsent(db, 'anthropic')`.
- Pass `synthesizer`, `consentCheck`, `minSynthesisScore`, `synthesisTopN`, `synthesisMaxTokens` to `new RetrievalPipeline(...)`.
- Extend `CardBusEvents` interface with the five synthesis events.
- Bridge `pipeline.on('synthesisStart', e => cardBus.emit('synthesisStart', e))`, etc. (one bridge per event).
- Broadcast: `cardBus.on('synthesisStart', e => broadcast({type: 'synthesisStart', ...e}))`, etc.
- `.env.example`: add **all five** keys with brief comments (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `UPWELL_SYNTHESIS_MIN_SCORE`, `UPWELL_SYNTHESIS_TOP_N`, `UPWELL_SYNTHESIS_MAX_TOKENS`). Defaults should be shown commented out so users see what they're overriding when they uncomment.

**Patterns to follow:**
- Existing `VoyageEmbedder` instantiation block in `serve.ts` (lines 90-94)
- Existing `cardBus` bridge + broadcast pattern (lines ~115-185)

**Test scenarios:**
- Happy path — `ANTHROPIC_API_KEY` set + consent granted: synthesizer is instantiated, passed to pipeline, `consentCheck` returns `true`. (Test via dependency injection of a mocked `AnthropicSynthesizer` or via `serve.ts` instantiation that captures the options object.)
- Happy path — broadcast: `cardBus.emit('synthesisDelta', {...})` results in one WS message delivered with `{type: 'synthesisDelta', ...}`.
- Edge case — no `ANTHROPIC_API_KEY`: `serve.ts` boots normally, pipeline receives `synthesizer: undefined`. No errors at startup.
- Edge case — key present but consent not granted: synthesizer is instantiated, but `consentCheck` returns `false`. Pipeline gate prevents call.
- Integration — `.env.example` lists every new key. (Test by reading the file and asserting on key presence.)

**Verification:** Daemon starts cleanly with and without the new keys. The pipeline gate behavior changes correctly based on consent state. WS subscribers receive synthesis events when the pipeline emits them.

- [x] U6. **HUD: synthesis card streaming render + citation chips**

**Goal:** Extend the HUD's WS message handling and `Sidebar` to render a streaming synthesis card on top of the stream. Append delta chunks to the card body, render `[N]` citation chips that scroll to or open the matching raw card, retract the synthesis when `synthesisRetracted` arrives, fade in on start, remove cursor on done, and silently suppress refusal sentinels.

**Requirements:** R2, R5, R8, R9

**Dependencies:** U5

**Files:**
- Modify: `apps/hud/src/types.ts` (extend `ServerMessage`)
- Modify: `apps/hud/src/sidebar.ts` (new `renderSynthesisStart` / `appendSynthesisDelta` / `finalizeSynthesis` / `removeSynthesis` methods)
- Modify: `apps/hud/src/main.ts` (wire new event types)
- Modify: `apps/hud/src/styles.css` (synthesis card style + cursor animation + citation chip style + `.sr-only` utility)
- Modify: `apps/hud/index.html` (add the `#synthesis-announce` SR-only live region)
- Modify: `apps/hud/test/sidebar.test.ts`

**Approach:**
- `ServerMessage` discriminated union extended with: `synthesisStart {synthesisId, sourceCardIds, traceId}`, `synthesisDelta {synthesisId, delta}`, `synthesisDone {synthesisId, citations, stopReason}`, `synthesisError {synthesisId, code, message?}`, `synthesisRetracted {synthesisId, reason}`.
- `Sidebar.renderSynthesisStart(start)` — prepend `<article class="card synthesis" data-synthesis-id="..." aria-live="off"><header><span class="ai-label">AI summary</span></header><div class="synthesis-body"></div><span class="cursor">▊</span><footer class="citations"></footer></article>`. The card itself has `aria-live="off"` so per-token streaming does NOT spam screen-reader announcements. Tracked in `#syntheses: Map<synthesisId, {el, sourceCardIds, accumulatedText, renderedCitations: Set<number>}>`.
- A separate, persistent `<div id="synthesis-announce" aria-live="polite" class="sr-only"></div>` element (added to `index.html`) holds the finalized text — set once on `synthesisDone` so screen readers announce the full answer exactly once, not 30× during streaming.
- `Sidebar.appendSynthesisDelta(synthesisId, delta)` — locate the record, append `delta` to `accumulatedText` and to `.synthesis-body` `textContent`. Cheap; no Prism re-render. Eager citation rendering: scan the accumulated text for new `[N]` matches; for each `N` not already in `renderedCitations` AND within `sourceCardIds` range, add a `.citation-chip` to `.citations` with `data-card-id` set to `sourceCardIds[N-1]` (the existing raw cards already carry `data-card-id` — that's the single linking strategy; no `data-rank`) and a click handler that does `document.querySelector('[data-card-id="..."]')?.scrollIntoView({behavior: 'smooth'})`.
- `Sidebar.finalizeSynthesis(synthesisId, citations)` — remove the `▊` cursor element, set the `#synthesis-announce` element's textContent to the final accumulated text. Citations chips already rendered eagerly; **reconcile** by removing any chip whose source index is not in the final `citations` list (use `removeChild` on individual elements — never `innerHTML = ''` which would lose chips' event listeners).
- `Sidebar.removeSynthesis(synthesisId)` — remove the DOM node and the record. Used by both `synthesisError` and `synthesisRetracted`.
- Refusal suppression: U4 emits `synthesisError` with code `refused` when the LLM outputs the sentinel. HUD handles that exactly like other errors — removes the synthesis card silently. Optional: a 200ms "no match" pill could appear, deferred to dogfood feedback.
- CSS: `.card.synthesis` gets an accent border and a subtle fade-in (200-300ms opacity). `.cursor` is animated (CSS `@keyframes` blink). `.citation-chip` is a small `[N]` pill button with hover state.
- `main.ts` wiring: new `case 'synthesisStart'`, `'synthesisDelta'`, `'synthesisDone'`, `'synthesisError'`, `'synthesisRetracted'` in the existing `onMessage` switch, each calling the matching `Sidebar` method.

**Patterns to follow:**
- Existing `.provisional` class style as precedent for "this card is visually different"
- Existing `renderCard` / `insertBefore(streamEl.firstChild)` prepend pattern
- Existing citation/anchor pattern from the recent URL-link work (links to raw cards' DOM elements via `data-card-id`)

**Test scenarios:**
- Happy path — start → 3 deltas → done: synthesis card appears at the top with accumulated text from the 3 deltas; cursor removed on `done`; citation chips match the `citations` array on `done`.
- Eager citation — a delta containing `[2]` adds chip `[2]` immediately, before `done`.
- Edge case — citation chip click: clicking `[2]` scrolls the raw card whose `data-card-id` matches `sourceCardIds[1]` (1-indexed `[N]` mapped via `sourceCardIds[N-1]`). Test via `Element.scrollIntoView` mock.
- Accessibility — during streaming the synthesis card's `aria-live` is `off` (assert attribute). On `synthesisDone`, the `#synthesis-announce` SR-only element receives the final text (assert its `textContent`).
- Edge case — multiple syntheses concurrently (shouldn't happen given abort behavior, but defensive): two distinct `synthesisId`s render two distinct cards, deltas route correctly by ID.
- Refusal — `synthesisError` with code `refused`: the synthesis card is removed silently.
- Error — `synthesisError` with code other than `refused`: synthesis card removed; no error UI shown (daemon logs the cause).
- Retract — `synthesisRetracted`: synthesis card removed from DOM.
- Integration — `appendSynthesisDelta` does not re-render existing card DOM beyond appending text + chips (assert no full innerHTML rewrite via DOM mutation observer).

**Verification:** All scenarios pass. Manual smoke: live meeting produces a streaming synthesis card with clickable `[N]` chips that scroll to the raw cards below.

- [x] U7. **Telemetry: structured logs + cache observability**

**Goal:** Emit structured log lines at every synthesis event boundary so cost, latency, cache hit rate, abort rate, and refusal rate are observable from the daemon terminal during dogfood. Surface them in the format that the U24 telemetry stream (separate plan) will eventually consume.

**Requirements:** R6, R7, R10

**Dependencies:** U4, U5

**Files:**
- Modify: `apps/daemon/src/cli/serve.ts` (log lines)
- Modify: `apps/daemon/src/retrieve/pipeline.ts` (log on gate decisions)

**Approach:**
- `log('info', 'synthesis.skipped', {reason: 'no-consent' | 'no-key' | 'below-threshold' | 'no-results', topScore?})` — on gate skip.
- `log('info', 'synthesis.start', {synthesisId, sourceCardIds, traceId})` — on `synthesisStart` emit.
- `log('info', 'synthesis.done', {synthesisId, latencyMs, ttftMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, citations})` — on `synthesisDone`. Derives ttftMs from start time and first-delta time; latencyMs from start to done.
- `log('warn', 'synthesis.error', {synthesisId, code, message?, retryAfterMs?})` — on `synthesisError`.
- `log('info', 'synthesis.aborted', {synthesisId})` — when superseded by a new schedule.
- Cache observability: after the first call, the `synthesis.done` line should show `cacheCreationTokens > 0` and subsequent calls `cacheReadTokens > 0`. If we observe `cacheCreationTokens > 0` every call, the prefix isn't engaging cache — that's a hard signal to expand the few-shot block.

**Patterns to follow:**
- Existing `log('info', 'voyage.usage', {...u})` and `log('info', 'audio.frames ...')` lines

**Test scenarios:**
- Test expectation: none — logging-only changes around code already covered by U4/U5 functional tests. The structure is assertable via captured log lines if future tests want, but adding tests for every log call is over-test.

**Verification:** Live meeting produces the full log line set in the daemon terminal. After ~3 synthesis calls within a single meeting, at least the 2nd and 3rd `synthesis.done` lines show `cacheReadTokens > 0`. If not, U2's few-shot block is undersized — known follow-up.

---

## System-Wide Impact

- **Interaction graph:** `RetrievalPipeline` gains a fire-and-forget downstream call to the synthesizer. The synthesizer's iterator drives event emission on the same pipeline EventEmitter. `serve.ts` extends `CardBusEvents` and the broadcast loop. The HUD's `WsClient` already routes by `type` — new types are additive, no other consumer affected.
- **Error propagation:** Synthesis errors are isolated to the synthesis path. `SynthesisProviderError` and abort events do not bubble to retrieval or transcription. Raw cards continue to ship.
- **State lifecycle risks:** The in-flight `AbortController` and the "what cardIds did this synthesis cite" map are per-`MeetingSession` state. Cleanup on `meetingEnded`: cancel any in-flight synthesis, clear citation tracking. Cleanup on `cardRetracted`: cascade to `synthesisRetracted` for synthesis that cited the retracted card.
- **API surface parity:** `MeetingSession` (currently tracks surfaced docs + pinned cards) gains a synthesis-citation index. Pin/unpin behavior remains card-only (decision above: synthesis is not pinnable).
- **Integration coverage:** Pipeline tests already mock the embedder + DB. They will gain a `synthesizer` mock that yields a controlled async iterable. End-to-end "speak → synthesis appears" is dogfood-verified, not unit-tested.
- **Unchanged invariants:** The existing `card` / `cardUpdated` / `cardRetracted` events keep the same shape. The HUD's existing card rendering is untouched. The retrieval contract (RRF score, rank, snippet format) is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Few-shot prefix doesn't reach 4096 tokens → caching silently no-ops | U7 telemetry surfaces `cacheCreationTokens` per call; U2 includes a character-count assertion as a proxy; verify on first live call and expand examples if needed |
| Synthesis latency exceeds 5s and hits the timeout regularly | Default 5s timeout configurable via env; metric in U7 makes this observable; cached prefix should land TTFT <500ms making this unlikely |
| Hallucinated citations (LLM cites `[7]` when only 3 sources sent) | U2 post-hoc validation drops invalid citations; system prompt + few-shots reinforce "only cite numbered sources" |
| Refusal sentinel false-positive (LLM produces text starting with "No relevant context" but continuing) | Exact-match check on full output (not prefix); few-shot examples model the exact short form |
| Abort race during stream causes phantom `synthesisDone` events | `AbortError` is caught and re-thrown as a sentinel; pipeline distinguishes abort from error and emits neither `synthesisDone` nor `synthesisError` for aborts |
| Anthropic API outage breaks the HUD entirely | Synthesis fails silently — raw cards continue to ship; daemon logs the outage; no user-facing error |
| Consent revoked mid-meeting | `consentCheck` closure is called per schedule, so revocation takes effect on the next debounced flush; in-flight calls run to completion |
| Cost overrun on a high-activity meeting | U7 telemetry surfaces per-call usage; `UPWELL_SYNTHESIS_MIN_SCORE` can be raised to gate more aggressively if cost is an issue |

---

## Documentation / Operational Notes

- `.env.example` updates list the new keys with comments.
- Once the feature lands, a `docs/solutions/` entry capturing the Anthropic prompt-caching shape (cache_control placement + the 4096-token Haiku minimum) is a strong candidate. Tracked as a follow-up, not part of this plan.
- The synthesizer's structured log lines are stable enough for future telemetry consumers (U24 plan).
- Rollout: feature is opt-in via `ANTHROPIC_API_KEY` + `consent grant anthropic`. Users without the key or grant see the existing behavior.

---

## Sources & References

- **Origin document:** `docs/brainstorms/llm-synthesis-card-requirements.md`
- Related code: `apps/daemon/src/retrieve/pipeline.ts`, `apps/daemon/src/embed/voyage.ts`, `apps/daemon/src/cli/consent.ts`, `apps/daemon/src/cli/serve.ts`, `apps/hud/src/sidebar.ts`
- External docs: `https://platform.claude.com/docs/en/api/messages`, `https://platform.claude.com/docs/en/api/messages-streaming`, `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`, `https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations`
