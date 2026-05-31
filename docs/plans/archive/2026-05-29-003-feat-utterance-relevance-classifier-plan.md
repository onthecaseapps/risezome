---
title: "feat: Utterance-relevance pre-classifier — skip the pipeline on obvious filler"
type: feat
status: completed
date: 2026-05-29
origin: docs/brainstorms/utterance-relevance-classifier-requirements.md
---

# feat: Utterance-Relevance Pre-Classifier

## Overview

Add a pre-classifier gate at the top of `RetrievalPipeline.#evaluate` that decides whether an utterance is worth running the embed → retrieve → synthesize pipeline on at all. Two-stage decision:

1. A fast, deterministic **heuristic** that resolves the obvious cases at zero cost
2. A **Claude fallback** that decides genuinely ambiguous utterances

Only utterances the gate marks `surface` get the full pipeline. Skipped utterances generate a structured daemon log line and nothing else — no Voyage call, no card, no synthesis. The router classifier is untouched.

---

## Problem Frame

(See origin: `docs/brainstorms/utterance-relevance-classifier-requirements.md`)

Every finalized utterance currently triggers the full retrieval pipeline. A meaningful fraction of those utterances are pure conversational noise (acknowledgments, filler, social pleasantries, meta-meeting talk) that produce off-target HUD cards, waste Voyage embedding spend, and sometimes burn through to a wasted Claude synthesis call. The pipeline has no gate that decides whether to run on a given utterance — it just runs.

---

## Requirements Trace

- R1. Pre-classifier step runs at the top of `RetrievalPipeline.#evaluate`, before the embed call.
- R2. The pre-classifier sees only the latest finalized utterance (same input shape as the router heuristic), not the rolling windowText.
- R3. A fast regex / length-based heuristic decides obvious cases with zero LLM cost.
- R4. When the heuristic is ambiguous, a Claude call fires with a dedicated cached system prompt and returns `skip` or `surface` plus a confidence score.
- R5. The Claude call runs in parallel with the embed call. The pipeline awaits both before emitting cards.
- R6. Skip requires high LLM confidence (default threshold 0.7, env-configurable). Below threshold defaults to `surface`.
- R7. Any classifier failure (API error, timeout, missing key, revoked consent) defaults to `surface`.
- R8. Each skip writes a structured daemon log line: `utterance_text`, `gate` (`heuristic` or `llm`), `reason`, `confidence` (when LLM).
- R9. The pre-classifier reuses the existing Anthropic consent gate via the closure already passed to the pipeline.
- R10. The router classifier prompt and code path are unchanged.

---

## Scope Boundaries

- The pre-classifier never retracts already-surfaced cards. It only suppresses *new* pipeline runs.
- No HUD UI changes in v1 (no skip counter, no inspector panel).
- No always-on LLM mode — heuristic-gated only.
- No `defer` class (fragment hold-and-reevaluate).
- No bundling skip/rag/tool into the router classifier.
- No topic-shift detection that resets session dedup.
- No corpus-aware relevance signals (e.g., "does this utterance reference an indexed entity").

### Deferred to Follow-Up Work

- HUD skip-indicator UI: revisit after the daemon logs give labeled data to inform design.
- Calibration tooling: a script that replays a meeting transcript through the gate and reports skip/surface decisions per utterance for tuning. v2.

---

## Context & Research

### Relevant Code and Patterns

- `apps/daemon/src/router/heuristic.ts` — pure stateless `isToolShaped(text): boolean`. Closest precedent for the filler heuristic. Pattern-set-as-regexes plus length checks.
- `apps/daemon/src/router/anthropic-classifier.ts` — Claude classifier with retry loop, error categorization (auth-error / rate-limit / bad-request / network-error / overloaded / server-error / unknown), abort threading, and prompt caching. The new filler classifier mirrors this shape.
- `apps/daemon/src/router/contract.ts` — `Classifier` interface + `ClassifierResult` discriminated union. The relevance classifier follows the same contract style.
- `apps/daemon/src/router/prompt.ts` — cacheable system prompt at ~17,270 chars to hit Haiku's 4096-token cache floor, with diverse worked examples. The relevance prompt needs the same minimum.
- `apps/daemon/src/retrieve/pipeline.ts` — `#evaluate()` is where the router classifier is already wired in parallel with embed. Same integration shape applies here.
- `apps/daemon/src/retrieve/contract.ts` — `RetrievalPipelineEvents` discriminated union; `classifierStart` / `classifierDone` / `classifierSkipped` / `classifierError` events as a model for the new relevance events.
- `apps/daemon/src/transcript/window.ts` — `latestFinalUtteranceText()` accessor already exists from the router work and is the right input source per R2.
- `apps/daemon/src/cli/serve.ts` — event subscribers translate retrieve events into structured log lines. The pattern for telemetry plumbing is established.
- `apps/daemon/src/cli/consent-store.ts` — `hasConsent(db, 'anthropic')` is the consent check; the existing `consentCheck` closure on the pipeline applies to the relevance classifier too.

### Institutional Learnings

- The router prompt's 50-worked-example set was needed to hit the 4096-token cache floor at Haiku. The relevance prompt will need a similar count of skip/surface examples, with both clear skips and clear surfaces represented, plus several ambiguous cases that resolve to `surface` to bias the model toward the safer default per origin requirements decision D4 (default to surface on ambiguity). D1–D5 references throughout this plan point to anchor decisions in the origin requirements document; this is cross-reference, not local definition.
- Anthropic tool names must match `^[a-zA-Z0-9_-]{1,128}$`. Use `should_surface` or `classify_relevance`, not `classify.relevance` or `relevance/v1`.
- Per `docs/solutions/`-class learning embedded in this session: when a single utterance produces multiple pipeline flushes (debounce + windowChanged re-fire), the gate is hit multiple times for the same text. Memoize the latest decision within the meeting session so the LLM is not re-billed for identical text within a short window. (Implementation-level note; surfaced in U3.)

### External References

None needed. Local patterns are direct.

---

## Key Technical Decisions

- **Three-state heuristic, not two.** Heuristic returns `clearly_filler | clearly_substantive | ambiguous`. Only `ambiguous` fires the LLM. `clearly_substantive` short-circuits to `surface` without spending an LLM call on every long utterance.
- **Parallel-with-embed, await-before-emit.** Embed and the LLM call (when fired) run concurrently. Cards are NOT emitted until both have settled. This avoids needing card retraction if the LLM lands on `skip` after retrieval — cards just never appear. **Acknowledged cost:** Voyage spend is NOT saved on LLM-routed skips (the embed has already been billed by the time the classifier resolves). Only heuristic skips save Voyage. The success criterion "Voyage providerCalls drops in proportion to skip rate" applies primarily to the heuristic-skip portion of the total skip rate. LLM-routed skips still avoid the synthesis call, which is the larger Anthropic cost per surface.
- **Hard timeout instead of session-tracked abort.** The relevance classifier has a per-call timeout (default 3000ms via `UPWELL_RELEVANCE_TIMEOUT_MS`). When it trips, the call is treated as `surface`. A schedule-driven abort (similar to active-synthesis tracking) would require adding session-tracked classifier controllers, which would also require retrofitting the router classifier to use the same pattern — violating R10. Timeout is the cheaper alternative; a stale-but-completed classifier call is harmless because its result is just dropped.
- **Confidence threshold env var.** `UPWELL_RELEVANCE_SKIP_THRESHOLD` (default `0.7`). Below threshold → `surface`. Lets the user tune during dogfood without redeploying. **Calibration signal:** every LLM call (regardless of surface/skip outcome) emits a `relevance.classified` log line with `decision`, `confidence`, and `utterance` so the user can grep after a meeting and see the actual confidence distribution. Without this, the threshold env var is a knob with no readout.
- **Session-scoped memoization (skip only, normalized key).** Two flushes triggered by the same final utterance text within the same `MeetingSession` should not pay for two LLM calls. Only `skip` decisions are cached; the cache key is normalized (lowercase + trim + strip trailing punctuation) so trivial transcription variants collide. A soft TTL (~30s) prevents indefinite growth across long meetings.
- **Heuristic patterns are exhaustive in this plan.** R3 left exact patterns to planning; they are enumerated in U1 below so the implementer doesn't have to invent the set. The `clearly_substantive` interrogative list also includes imperative request forms (`tell me`, `show me`, `walk me through`, `explain`, `pull up`, `find`, `look up`) so short non-question requests don't fall into `ambiguous`.
- **`SystemBlock` type stays local.** Each classifier (router, relevance) defines its own `SystemBlock` interface in its own `prompt.ts`. The Anthropic `cache_control` shape is stable; duplication is cheaper than premature extraction. Revisit if a third classifier ships.
- **Log full utterance text.** v1 stays local-only; the daemon writes to stdout the user already reads. Privacy redaction can come later when (if) logs ship somewhere persistent.
- **No new dependency on `@anthropic-ai/sdk`** beyond what `AnthropicSynthesizer` and `AnthropicClassifier` already pull in.

---

## Open Questions

### Resolved During Planning

- *Where does the LLM call live?* Separate classifier in `apps/daemon/src/relevance/`. Mirrors `router/` directory shape.
- *What are the heuristic patterns?* Enumerated in U1.
- *What's the confidence threshold default?* 0.7, env-configurable. Calibration signal comes from per-call `relevance.classified` log lines, not just skip lines.
- *Do we cache repeat decisions?* Yes, but only `skip` decisions, keyed by normalized utterance text (lowercase + trim + strip trailing punctuation), with 30s TTL.
- *What happens to cards emitted before the LLM decides?* Cards aren't emitted until LLM (when fired) returns. Avoids retraction.
- *How does a hanging classifier end?* Hard timeout (default 3000ms). No schedule-driven abort because the router classifier doesn't have one and adding session-tracked controllers would violate R10.
- *Where does `SystemBlock` come from?* Locally defined in `relevance/prompt.ts`. Same shape as in `router/prompt.ts`; duplication accepted over premature extraction.
- *Are Voyage savings proportional to skip rate?* Only for heuristic skips. LLM skips don't save Voyage (the parallel embed already ran) — they save synthesis. Acknowledged in Key Technical Decisions.

### Deferred to Implementation

- Exact LLM prompt wording and final worked-example count (U2). Target the 4096-token cache floor with diverse examples; precise content emerges during writing.
- Whether the heuristic should also catch non-English filler patterns. Probably not in v1; revisit if a non-English meeting reveals a gap.
- Whether to expose a `relevance.skipped` event on the HUD WS channel for future HUD inspector work. Wire the event through `RetrievalPipelineEvents` (U3) but don't broadcast to HUD; the path is ready when v2 design lands.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*
>
> *Event names below (camelCase like `relevanceSkip`) are programmatic identifiers on the `RetrievalPipelineEvents` discriminated union. They are translated to dot-separated log line keys (`relevance.skipped`) in `serve.ts` per U4.*

```
RetrievalPipeline.#evaluate(triggeredBy):
  latestUtterance = window.latestFinalUtteranceText()
  embedInput = latestUtterance ?? windowText.text          // existing
  isToolShaped = router.heuristic(latestUtterance)         // existing
  relevance = filler.heuristic(latestUtterance)            // NEW

  if relevance == clearly_filler:
    emit relevanceSkip { gate: 'heuristic', reason }
    return                                                  // no embed, no retrieve

  embedPromise = embedder.embed(embedInput)
  classifierPromise = (relevance == ambiguous && classifier && consent)
                       ? fillerClassifier.classify(latestUtterance, abort)
                       : null                               // synchronous "surface"
  routerClassifierPromise = (isToolShaped && router.classifier && consent)
                       ? router.classify(latestUtterance, abort)   // existing
                       : null

  embedded = await embedPromise
  results = hybridSearch(embedded.vector, embedInput)

  if classifierPromise:
    decision = await classifierPromise with timeout(3000ms)  // null on error/timeout
    session.recordRelevance(latestUtterance, decision)        // cache skip decisions
    emit relevanceClassified { decision, confidence }          // calibration signal
    if decision == 'skip' && confidence >= threshold:
      emit relevanceSkip { gate: 'llm', reason, confidence }
      return                              // cards never emitted

  // emit cards (existing logic)
  // await routerClassifierPromise, run skill, synthesize (existing logic)
```

Key shape: the relevance gate is a third filter *upstream* of card emission. The router classifier (tool path) is a downstream collaborator that still runs in parallel; the two are independent.

---

## Output Structure

```
apps/daemon/
├── src/
│   └── relevance/                        # NEW directory
│       ├── heuristic.ts                  # U1
│       ├── contract.ts                   # U2
│       ├── prompt.ts                     # U2
│       └── anthropic-classifier.ts       # U2
└── test/
    └── relevance/                        # NEW directory
        ├── heuristic.test.ts             # U1
        └── anthropic-classifier.test.ts  # U2
```

Plus modifications to `apps/daemon/src/retrieve/pipeline.ts`, `apps/daemon/src/retrieve/contract.ts`, `apps/daemon/src/meeting/session.ts`, `apps/daemon/src/cli/serve.ts`, and `apps/daemon/test/retrieve/pipeline.test.ts`.

---

## Implementation Units

- [x] U1. **Filler heuristic — pure tristate function**

**Goal:** Provide a fast, deterministic classifier returning one of `clearly_filler | clearly_substantive | ambiguous` over a single utterance string.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Create: `apps/daemon/src/relevance/heuristic.ts`
- Test: `apps/daemon/test/relevance/heuristic.test.ts`

**Approach:**
- Export `classifyRelevanceHeuristic(text: string): 'clearly_filler' | 'clearly_substantive' | 'ambiguous'`.
- Lowercase + trim input.
- Patterns to mark `clearly_filler` (use word-boundary regexes so they don't accidentally match inside longer utterances):
  - Single-word acknowledgments: `^(yeah|yes|yep|nope|no|ok|okay|right|sure|sure thing|cool|nice|true|mm-?hm+|uh-?huh|hmm+|ah|oh|huh|alright|got it|fair)$`
  - Stock filler phrases (whole utterance): `^(let me think|let's see|you know|i mean|i guess|i think so|i don't know|i'm not sure|that makes sense|good point|agreed|sounds good|exactly|totally)\.?$`
  - Social pleasantries: `^(hi|hello|hey|thanks|thank you|thanks a lot|cheers|bye|goodbye|see you|talk soon)\.?$`
  - Meta-meeting talk: `^(where were we|moving on|next item|next topic|next one|let's move on|let's continue|let's keep going)\.?$`
  - Length: utterance fewer than 3 characters after trimming → `clearly_filler`.
- Patterns to mark `clearly_substantive`:
  - Contains a `?` anywhere
  - Starts with an interrogative word: `^(how|what|why|where|when|which|who|whose|whom|can|could|should|would|do|does|did|is|are|was|were|will|won't|don't|doesn't)\b`
  - Starts with an imperative request form: `^(tell me|show me|walk me through|explain|find|search|look up|pull up|remind me|i want to know|i need to)\b`
  - Length ≥ 80 characters (long utterances are *usually* substantive; risk of long social filler acknowledged in Risks)
  - Contains a path-like token (`/`, `\`, `:`), file extension (`\.[a-z]{1,5}$` per word), or backticks
- Everything else → `ambiguous`.
- Patterns are exported as `export const FILLER_PATTERNS: readonly RegExp[]` and `export const SUBSTANTIVE_PATTERNS: readonly RegExp[]` (mirroring `apps/daemon/src/router/heuristic.ts`'s `HEURISTIC_PATTERNS` export) so tests can iterate over the set without re-deriving regexes.
- Export a `normalizeForRelevance(text: string): string` helper that performs `lowercase + trim + strip trailing punctuation`. Used both internally by the heuristic and by `MeetingSession.recordRelevance` / `getCachedRelevance` for cache-key normalization.

**Patterns to follow:**
- `apps/daemon/src/router/heuristic.ts` — single pure function, no state, no imports beyond TS standard.

**Test scenarios:**
- Happy path: each pattern in the `clearly_filler` set returns `clearly_filler` (one assertion per family is sufficient — single-word acks, stock filler, social, meta).
- Happy path: each pattern in the `clearly_substantive` set returns `clearly_substantive` (interrogative-start, question mark, long, path-like).
- Edge case: empty string → `clearly_filler`.
- Edge case: whitespace-only string → `clearly_filler`.
- Edge case: case-insensitive — "YEAH" returns `clearly_filler`.
- Edge case: trailing punctuation — "yeah." and "yeah!" both return `clearly_filler`.
- Edge case: "yeah so the auth thing is broken" (filler prefix + substantive content) returns `ambiguous` — the prefix is filler but the rest is substantive content not matched by a clearly_substantive pattern (no `?`, no interrogative start). This is intentional per D4: surface on ambiguity.
- Edge case: "?" alone returns `clearly_substantive` (question mark present). Acceptable; the substantive gate is conservative.
- Edge case: utterance with named identifier mid-sentence ("the auth.ts file is broken") matches path-like → `clearly_substantive`.
- Edge case: "tell me about the rag pipeline" → matches imperative request form → `clearly_substantive`.
- Edge case: "oh wait no I totally hear you that was the same thing I was just thinking earlier today before this call" (long pure-filler) → `clearly_substantive` per the ≥80-char rule. Test pinned to document the known tradeoff; behavior may change in a follow-up if dogfood logs show frequent long-filler false surfaces.
- Boundary: utterance of exactly 79 characters with no other substance markers → `ambiguous`; 80 characters → `clearly_substantive`.
- Helper test: `normalizeForRelevance("Yeah!")` returns `"yeah"`; `normalizeForRelevance("  How does X work?  ")` returns `"how does x work?"`.

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- No runtime imports from `apps/daemon/src/relevance/heuristic.ts` outside this unit yet.

---

- [x] U2. **Anthropic filler classifier**

**Goal:** Provide a Claude-backed classifier that decides `skip` vs `surface` for an ambiguous utterance and returns a confidence score.

**Requirements:** R4, R6, R7

**Dependencies:** U1 (for contract shape only; U2 does not import U1's heuristic)

**Files:**
- Create: `apps/daemon/src/relevance/contract.ts`
- Create: `apps/daemon/src/relevance/prompt.ts`
- Create: `apps/daemon/src/relevance/anthropic-classifier.ts`
- Test: `apps/daemon/test/relevance/anthropic-classifier.test.ts`

**Approach:**
- `contract.ts` exports:
  - `RelevanceClassifier` interface with one method: `classify(utterance: string, abort?: AbortSignal): Promise<RelevanceResult>`
  - `RelevanceResult` discriminated union: `{ decision: 'surface' } | { decision: 'skip', confidence: number, reason: string }`
  - `RelevanceProviderError` mirroring `ClassifierProviderError` with `kind` discriminator (`auth-error | rate-limit | bad-request | network-error | overloaded | server-error | unknown`) and optional `retryAfterMs`
- `prompt.ts` exports `buildRelevanceSystem(): SystemBlock[]` returning a single cacheable block (`cache_control: { type: 'ephemeral' }`) with ≥4096 tokens of content. Content includes:
  - The classification task framed as "decide whether this utterance is worth running an information-retrieval pipeline on."
  - Examples skewed toward the conservative bar from D1 — only skip when clearly filler. ~40 skip examples + ~40 surface examples + ~10 ambiguous examples that resolve to surface.
  - Explicit instruction: "When unsure, choose surface. Choose skip only when confidence is at least 0.7."
- `anthropic-classifier.ts` exports `AnthropicRelevanceClassifier implements RelevanceClassifier`:
  - Constructor takes `{ apiKey, model, onUsage? }` matching `AnthropicClassifier`.
  - Uses Messages API with `tool_choice: { type: 'auto' }` and a single tool `should_surface` with input schema `{ decision: 'surface' | 'skip', confidence: number, reason: string }`.
  - Tool-use response parsing scans the full `content` array for the first `tool_use` block (not `content[0]`) — same lesson as the router classifier.
  - Retry loop mirrors `AnthropicClassifier` (429 with Retry-After, 5xx transient, 401/400 no-retry, abort threading).
  - On any error, throws `RelevanceProviderError`; the pipeline catches and defaults to `surface` (R7).

**Execution note:** Test-first for the classifier response parsing. Multiple regression-class bugs in the router classifier (tool_use scan, abort, etc.) came from undertested response shapes; write the failing test for each before implementing.

**Patterns to follow:**
- `apps/daemon/src/router/contract.ts` — discriminated unions, error class shape.
- `apps/daemon/src/router/anthropic-classifier.ts` — retry loop, abort, prompt caching usage tracking via `onUsage`.
- `apps/daemon/src/router/prompt.ts` — cache-floor-targeted prompt construction.
- `apps/daemon/test/router/anthropic-classifier.test.ts` — mocked Messages API, tool-use response shapes, retry verification.

**Test scenarios:**
- Happy path: valid tool_use response with `surface` → returns `{ decision: 'surface' }`.
- Happy path: valid tool_use response with `skip` + confidence 0.9 → returns `{ decision: 'skip', confidence: 0.9, reason }`.
- Edge case: tool_use is in `content[1]` after a text preamble — parser still finds it.
- Edge case: response has text only, no tool_use — throws `bad-request` error (model misbehaved).
- Edge case: response has multiple tool_use blocks — first one wins.
- Error path: 429 with `retry-after: 1` header → retries once after waiting; succeeds on retry.
- Error path: 401 → throws `auth-error` immediately, no retry.
- Error path: 500 → retries up to max, then throws `server-error`.
- Error path: aborted mid-call → throws AbortError; subsequent retries don't fire.
- Integration: prompt builder returns a system block with `cache_control: ephemeral` set and total token count ≥ 4096 (use a token estimator, not an exact count).

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- The classifier can be instantiated in isolation with a fake `fetch` and produces deterministic results.

---

- [x] U3. **Pipeline integration — gate at the top of `#evaluate`, parallel-with-embed, session memoization**

**Goal:** Wire the heuristic and classifier into the retrieval pipeline so utterances marked `skip` never reach card emission.

**Requirements:** R1, R2, R5, R6, R7, R8 (event emission), R9 (consent), R10 (router untouched)

**Dependencies:** U1, U2

**Files:**
- Modify: `apps/daemon/src/retrieve/pipeline.ts`
- Modify: `apps/daemon/src/retrieve/contract.ts` — extend `RetrievalPipelineEvents` discriminated union with the four new events defined below
- Modify: `apps/daemon/src/meeting/session.ts` — add `relevanceCache` Map + `getCachedRelevance` / `recordRelevance` accessors
- Test: `apps/daemon/test/retrieve/pipeline.test.ts` (extend)

**Approach:**
- `RetrievalPipelineOptions` gains optional `relevanceClassifier?: RelevanceClassifier` and optional `relevanceSkipThreshold?: number` (default 0.7).
- At the top of `#evaluate`, after computing `latestUtterance`:
  1. Run `classifyRelevanceHeuristic(latestUtterance)`. If `clearly_filler` → emit `relevanceSkip { gate: 'heuristic', reason: 'matched filler pattern', utterance: latestUtterance, traceId }`, decrement inflight, return.
  2. If `clearly_substantive` → set `relevancePromise = null`, continue as today.
  3. If `ambiguous` AND classifier present AND consent granted → emit `relevanceLlmStart { utterance, traceId }`, set `relevancePromise = classifier.classify(latestUtterance, signal)`, continue.
  4. Otherwise (ambiguous with no classifier or no consent) → `relevancePromise = null`, continue (default to surface per R7).
- Embed runs as today, in parallel with `relevancePromise` if non-null.
- After retrieval completes but BEFORE the `for (const r of results)` card-emission loop:
  - If `relevancePromise !== null`, `await` it with a hard timeout (default 3000ms; see Key Technical Decisions). On timeout or any throw, log via `relevanceLlmError`, treat as surface, and continue. (This is the *only* mechanism that ends a hanging classifier — there is no schedule-driven abort because the router classifier doesn't have one today and adding session-tracked controllers would violate R10.)
  - Record the result on the session: `session.recordRelevance(latestUtterance, result)` so subsequent flushes within the TTL hit the cache.
  - If result is `{ decision: 'skip', confidence }` AND `confidence >= relevanceSkipThreshold`:
    - Emit `relevanceSkip { gate: 'llm', reason, confidence, utterance, traceId }`
    - Emit `relevanceLlmDone { decision: 'skip', confidence, latencyMs, traceId }`
    - Decrement inflight and return — no cards emitted, no synthesis.
  - Otherwise emit `relevanceLlmDone { decision: result.decision, confidence: result.decision === 'skip' ? result.confidence : null, latencyMs, traceId }` and continue. The `confidence: null` case carries the `surface` decision (the contract has no confidence field for surface).
- `MeetingSession` gains a `relevanceCache: Map<string, { result: RelevanceResult, at: number }>`. The cache key is the **normalized** utterance text (lowercase + trim + strip trailing punctuation) so that `"OK"`, `"ok."`, and `"ok"` collapse — matching what the heuristic considers equivalent. `#evaluate` checks the cache *before* firing the classifier; if a result exists within 30s, reuse it without firing the API call. New methods on `MeetingSession`: `getCachedRelevance(utterance)`, `recordRelevance(utterance, result)` — both internally normalize. Tunable TTL constant in `session.ts`. Only `skip` decisions are memoized; `surface` decisions are not cached since the cost of re-firing on surface is just the next classifier call (cheap), and caching surface risks pinning a wrong-decision when the heuristic was ambiguous.
- New events on `RetrievalPipelineEvents`:
  - `relevanceSkip { utterance: string, gate: 'heuristic' | 'llm', reason: string, confidence?: number, traceId: string, utteranceId?: string }`
  - `relevanceLlmStart { utterance: string, traceId: string, utteranceId?: string }`
  - `relevanceClassified { utterance: string, decision: 'surface' | 'skip', confidence: number | null, latencyMs: number, traceId: string, utteranceId?: string }` — emitted on every LLM call regardless of outcome. This is the calibration signal that makes the threshold tunable.
  - `relevanceLlmError { code: string, message: string, traceId: string, utteranceId?: string }`

**Execution note:** Test-first for the integration. The router integration shipped with three latent issues caught only by extending pipeline tests aggressively; mirror that posture.

**Patterns to follow:**
- `apps/daemon/src/retrieve/pipeline.ts` — existing router classifier integration is the structural template (parallel-with-embed, post-retrieval await).
- `apps/daemon/src/retrieve/contract.ts` — discriminated `RetrievalPipelineEvents` union pattern.
- `apps/daemon/test/retrieve/pipeline.test.ts` — fake classifier injection, traceId assertions, event-emission verification.

**Test scenarios:**
- Happy path (heuristic skip): utterance "yeah" → heuristic returns `clearly_filler` → `relevanceSkip` event fires with `gate: 'heuristic'` → no embed call → no cards.
- Happy path (heuristic surface, no LLM): utterance "how does the rag pipeline work" → heuristic returns `clearly_substantive` → classifier is NOT called → embed and cards proceed as today.
- Happy path (LLM skip): heuristic returns `ambiguous` → LLM returns `{ decision: 'skip', confidence: 0.9 }` → `relevanceSkip { gate: 'llm', confidence: 0.9 }` fires → no cards emitted (even though retrieval ran).
- Happy path (LLM surface): heuristic returns `ambiguous` → LLM returns `{ decision: 'surface' }` → cards emitted as today.
- Edge case (LLM below threshold): heuristic ambiguous → LLM returns `{ decision: 'skip', confidence: 0.5 }` with threshold 0.7 → treated as surface; cards emitted.
- Edge case (no classifier): pipeline constructed without `relevanceClassifier` → ambiguous utterances default to surface; no relevance events fire on the LLM path.
- Edge case (consent revoked): classifier present but `consentCheck()` returns false → ambiguous utterances default to surface without calling the classifier.
- Edge case (custom threshold): `relevanceSkipThreshold: 0.95` → LLM `skip` at 0.9 is now treated as surface.
- Error path (classifier throws): classifier rejects with `RelevanceProviderError(rate-limit)` → `relevanceLlmError` event fires → pipeline continues as surface (cards emitted).
- Error path (classifier hangs): classifier promise never resolves → 3000ms timeout trips → `relevanceLlmError` with `code: 'timeout'` → pipeline continues as surface. Verify with a controllable fake that holds resolution past the timeout.
- Memoization (skip cached): heuristic ambiguous → LLM returns `skip` with confidence ≥ threshold → second flush within 30s with same normalized text reuses cached skip without firing the classifier.
- Memoization (surface not cached): heuristic ambiguous → LLM returns `surface` → second flush re-fires the classifier (surface decisions are not cached per Key Technical Decisions).
- Memoization (key normalization): `"yeah"`, `"Yeah."`, and `"YEAH"` all collide on the cache key.
- Memoization expiry: cache miss after 31s of simulated time → classifier is called again.
- Calibration logging: every LLM call fires `relevanceClassified` regardless of surface/skip outcome, with the confidence value. Verify the event fires on both decision branches.
- Integration: router classifier and relevance classifier both run on the same `ambiguous` + `tool-shaped` utterance — both promises resolve, both decisions are honored independently, no cross-contamination.

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- Existing router tests still pass unchanged (R10).

---

- [x] U4. **Serve.ts wiring + structured log lines**

**Goal:** Instantiate the relevance classifier, pass it to the pipeline, and translate its events into structured daemon log lines per R8.

**Requirements:** R8, R9 (consent already wired; this unit confirms the pipeline receives it)

**Dependencies:** U2, U3

**Files:**
- Modify: `apps/daemon/src/cli/serve.ts`

**Approach:**
- Read `UPWELL_RELEVANCE_SKIP_THRESHOLD` (default 0.7) via the existing `envFloat` helper.
- Instantiate `AnthropicRelevanceClassifier` whenever `ANTHROPIC_API_KEY` is set (same condition as the router classifier). On absence, log `relevance.disabled reason=no-key`.
- Pass `relevanceClassifier` and `relevanceSkipThreshold` into the `RetrievalPipeline` constructor.
- Subscribe to the new events with `log('info', ...)` lines following the existing telemetry shape:
  - `relevance.skipped utterance="..." gate=heuristic reason="..." traceId=...`
  - `relevance.skipped utterance="..." gate=llm reason="..." confidence=0.92 traceId=...`
  - `relevance.start utterance="..." traceId=...`
  - `relevance.classified utterance="..." decision=surface confidence=0.62 latencyMs=523 traceId=...` (calibration; fires on every LLM call regardless of decision)
  - `relevance.error code=timeout message="..." traceId=...`
- Also subscribe to the existing `classifierSkipped` event (router) for consent-related disable so the user can spot when consent has been revoked mid-meeting.
- Log line emitted at startup: `relevance.enabled threshold=0.7 timeoutMs=3000` or `relevance.disabled reason=no-key`.

**Patterns to follow:**
- `apps/daemon/src/cli/serve.ts` lines wiring `classifier` (router) — same shape applies here.
- Existing event subscriber block (`cardBus.on(...)`) immediately after pipeline construction.

**Test scenarios:**
- Test expectation: none — this unit is wiring with no behavioral logic of its own. The pipeline tests in U3 cover the behavioral contract using a fake classifier. Manual verification path: start the daemon with `ANTHROPIC_API_KEY` set, speak a filler utterance, confirm the log line appears.

**Verification:**
- `pnpm typecheck` clean.
- `pnpm test` passes including all of U1, U2, U3.
- Manual dogfood: starting the daemon, the startup log shows `relevance.enabled threshold=0.7`. Speaking "yeah" produces a `relevance.skipped gate=heuristic` line. Speaking a substantive question produces no relevance log lines and the pipeline runs as today.

---

## System-Wide Impact

- **Interaction graph:** The pre-classifier sits upstream of every downstream pipeline behavior — embedding, hybrid search, card emission, synthesis, and router/tool dispatch. A skip decision short-circuits all of them.
- **Error propagation:** Classifier errors are caught at the await site and translated to `surface`. The pipeline never fails on a flaky classifier.
- **State lifecycle risks:** The session-scoped memoization cache could grow unbounded in a long meeting. 30s TTL + lazy eviction on `getCachedRelevance` keeps it bounded.
- **API surface parity:** No public-facing API changes. Internal events on `RetrievalPipelineEvents` add four members; consumers ignoring them are unaffected (`switch` statements at consumer sites have `default` cases that no-op).
- **Integration coverage:** The U3 integration test that fires both the router classifier and the relevance classifier on the same utterance is the key cross-layer scenario unit tests alone won't prove.
- **Unchanged invariants:** Router classifier prompt and code path unchanged (R10). HUD WebSocket message types unchanged. Card emission contract unchanged. Synthesis behavior unchanged when a relevance `surface` decision lands.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LLM falsely skips a real question. | High confidence threshold (default 0.7), prompt biased toward `surface` on uncertainty (D4), and visible daemon log lines so the user can spot bad skips during dogfood. The per-call `relevance.classified` log (not just `relevance.skipped`) gives a confidence distribution so the user can validate whether 0.7 is the right cutoff or whether confident-but-wrong skips are slipping through. Env-var threshold lets the user dial up to 0.9 if false skips appear. |
| LLM confidently wrong about a real question (model outputs `skip` with high confidence for a substantive utterance). | The above-threshold log line records the utterance text + confidence so post-meeting review can identify confident-false-skips. If a pattern emerges, the calibration tool (deferred to v2) becomes higher priority and the threshold should rise. v1 mitigation: high default threshold + prompt examples biased toward surface on uncertainty. |
| Heuristic 80-char rule over-surfaces long pure-filler ("oh wait no I totally hear you that was the same thing I was just thinking earlier today"). | Acknowledged tradeoff — long social filler runs the pipeline. Synthesis confidence gate + time-windowed dedup downstream still suppress the resulting card if retrieval doesn't find a strong match. If logs show repeated long-filler false surfaces, weaken the length rule (require length AND non-filler vocabulary) in a follow-up. |
| LLM adds latency on every ambiguous utterance. | Parallel-with-embed shape (R5). Classifier latency ~500ms with prompt caching; overlaps with Voyage embed latency. Net latency add is bounded by `max(classifier, embed) - embed`. |
| Session memoization cache returns stale decisions if the same text reappears later in the meeting with a different intent (rare). | 30s TTL keeps cache small. Even if a stale `skip` decision recurs, the cost is one missed surface — same cost asymmetry as any other false skip. |
| The classifier's 4096-token cache floor isn't actually hit (e.g., prompt comes in at 3800 tokens). | Verify token count in the U2 prompt test. The router prompt's worked-example expansion path is the recipe. |
| Heuristic patterns catch non-English filler poorly. | Out of scope for v1 (explicit non-goal). If the dogfood user records a non-English meeting and a regression appears, follow up in v2. |
| Pipeline-test fakes drift from the real Anthropic classifier behavior. | U2's contract tests pin the real classifier behavior. U3's integration tests use the same `RelevanceClassifier` interface, so the fake is forced to match the contract. |

---

## Documentation / Operational Notes

- Add `UPWELL_RELEVANCE_SKIP_THRESHOLD` (default `0.7`) and `UPWELL_RELEVANCE_TIMEOUT_MS` (default `3000`) to `.env.example` with one-line descriptions.
- Update the daemon's startup log block to confirm `relevance.enabled threshold=0.7 timeoutMs=3000` appears when the classifier is wired, and `relevance.disabled reason=no-key` otherwise.
- Mid-meeting consent revocation now downgrades three Claude-backed behaviors simultaneously (synthesis, router, relevance). The existing `classifierSkipped` log already covers the router; U4 adds the relevance equivalent. Operators monitoring a dogfood meeting see three log lines per flush when consent is revoked — intentional but worth knowing.
- No README changes needed; this is internal behavior.

---

## Sources & References

- **Origin document:** [docs/brainstorms/utterance-relevance-classifier-requirements.md](../brainstorms/utterance-relevance-classifier-requirements.md)
- **GitHub issue:** https://github.com/Nath5/upwell/issues/16
- Router precedent: `apps/daemon/src/router/` (heuristic, contract, anthropic-classifier, prompt, tests)
- Pipeline integration template: `apps/daemon/src/retrieve/pipeline.ts` `#evaluate()`
- Prior plan it builds on: [docs/plans/2026-05-29-002-feat-router-skills-framework-plan.md](2026-05-29-002-feat-router-skills-framework-plan.md)
