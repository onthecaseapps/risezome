---
title: feat: Rolling meeting summary for long-range context + coherence-in-context classification
type: feat
status: active
date: 2026-05-31
origin: docs/brainstorms/rolling-meeting-summary-requirements.md
---

# Rolling Meeting Summary

## Overview

Add a periodic side-call to Claude that produces a structured rolling
summary of the meeting so far, then plug that summary into two
consumers: the synthesizer (so it has long-range topic context) and
the relevance classifier (so it can judge coherence of new utterances
in context, not in isolation). Cadence is pause-debounced (15
utterances OR 120s, whichever first, with a 10s talking-pause
guard). Internal-only — no user-facing summary surface in V1.

---

## Problem Frame

The just-shipped recent-context fix (`SynthesisInput.recentContext`
plumbed through `buildUserMessage`) passes the last 5 final utterances
to the synthesizer for short-range pronoun + fragment resolution.
That handles the under-60s window. Two gaps remain:

1. **Long-range topic memory.** By minute 20, "about that auth flow
   we were discussing" has no resolution. The 5-utterance window can't
   reach back; sending the whole transcript per synthesis call burns
   linear token cost.

2. **Classifier judges in isolation.** The existing
   `AnthropicRelevanceClassifier` decides `surface` vs `skip` from
   the utterance alone. "in the app" looks like filler regardless of
   what was just discussed. With prior context, the same utterance is
   a coherent follow-up worth synthesizing.

A rolling structured summary, refreshed at conversation pauses, gives
both consumers the long-range context they need at a flat, predictable
per-hour cost.

(see origin: `docs/brainstorms/rolling-meeting-summary-requirements.md`)

---

## Requirements Trace

- R1. Coherence-in-context test passes: "in the app and where in the
  code base are they" is classified `surface` (not skipped) after
  "are any LLMs leveraged" was said immediately prior (see origin
  success criteria #1, #3).
- R2. Long-range memory test passes: a question 20 minutes into a
  meeting referencing a topic discussed at minute 5 retrieves
  topic-relevant sources (see origin success criteria #2).
- R3. Cost budget: rolling summary adds <$1/hour of meeting wall-clock
  to the Anthropic bill at typical cadence (see origin success
  criteria #4).
- R4. Latency budget: summary call p95 <2s, never blocks an in-flight
  synthesis (see origin success criteria #5).
- R5. Cold-start grace: the first 2 minutes of a meeting work as well
  as today, before any summary has fired (see origin success
  criteria #6).
- R6. Pause-debounced cadence: summary fires when N=15 finals OR
  M=120s elapsed since last summary AND the most recent utterance is
  ≥10s old (origin D1).
- R7. Hybrid output schema: `{ summary, current_topic, open_questions,
  key_terms }`, the same artifact consumed by both synthesizer and
  classifier (origin D2).
- R8. Synthesizer integration: the summary's `summary` prose is
  prepended to `recentContext` as the oldest entry; recent 5
  utterances follow (origin D3).
- R9. Relevance classifier integration: `current_topic` +
  `open_questions` are passed alongside the utterance so the
  classifier can judge coherence-in-context (origin D4).
- R10. In-memory only for V1; full transcript + latest summary live
  in the bot-worker runtime; both die with the meeting (origin D5).
- R11. Cost safeguards: max 1 summary per 60s wall-clock; bounded
  transcript (max 20K chars, sliding window if larger); retain prior
  summary on refusal (origin D6).
- R12. Debug page `/debug/live-mic` exposes the current summary in
  real time so the developer can iterate on the summarizer prompt
  visually (origin success criteria #7).

---

## Scope Boundaries

- No user-facing summary surface in the live page UI. Internal
  infrastructure only.
- U5 introduces a heuristic-first + LLM-on-ambiguous relevance
  classifier call to the debug pipeline that didn't have one. The
  Recall production pipeline already does this; the debug pipeline
  gains parity here as a prerequisite for context-aware
  classification. Net new Anthropic call rate: bounded by the
  heuristic gate (only ambiguous utterances reach the LLM), same
  rate-shape as production.
- The daemon (legacy desktop `apps/daemon`) does NOT get the
  summarizer runtime. Its `classify()` call site is migrated to the
  new options-object shape (U4) but doesn't pass context — daemon
  keeps the isolated-utterance classification behavior. Bot-worker
  is the production path; the daemon is a development surface only.
- No DB persistence of rolling summaries. In-memory only for V1.
- No embedding-similarity gating against `current_topic` for
  side-chat detection — the goal is coherence-in-context judgment
  (origin clarification), not thematic filtering.
- No speaker-attributed summary structure. Single meeting-level
  summary; multi-speaker awareness is a future refinement.
- No adaptive cadence tuning. Fixed N/M/D defaults; instrument cost +
  freshness signals before adding control loops.

### Deferred to Follow-Up Work

- **Cross-meeting memory**: summaries from prior meetings as
  retrievable context for future meetings. Approach 3 from the
  brainstorm; revisit after single-meeting V1.
- **DB persistence of rolling summaries**: enables resume + audit
  trail.

---

## Context & Research

### Relevant Code and Patterns

- **`packages/engine/src/synthesize/anthropic.ts`** —
  `AnthropicSynthesizer` is the existing Anthropic-call pattern:
  constructor takes `{apiKey, baseUrl, model, maxTokens, temperature,
  fetchImpl, maxRetries, onUsage, onRetryWait}`. Streams via SSE.
  The new `AnthropicSummarizer` mirrors this constructor shape so
  the bot-worker can instantiate it in the same conditional block
  (existing `if (anthropicKey !== undefined)`).
- **`packages/engine/src/relevance/anthropic-classifier.ts`** —
  `AnthropicRelevanceClassifier` is a closer analog (non-streaming,
  tool-use output via `buildRelevanceTool`). The summarizer should
  use tool-use too so Claude is forced to emit the structured shape
  rather than free-form JSON that needs validation.
- **`packages/engine/src/relevance/contract.ts`** —
  `classify(utterance, signal)` is the current signature. Adding an
  optional `context` arg as the third param keeps the contract
  backward-compatible. The change is in the type + the prompt
  builder; no breaking changes to existing call sites that don't pass
  context.
- **`packages/engine/src/synthesize/prompt.ts`** —
  `buildUserMessage(utterance, sources, recentContext?)` already
  exists from the just-shipped commit. Summary prose plugs into
  `recentContext` as the oldest entry; the function's existing
  format ("Recent transcript (oldest first; treat the most recent as
  the question)") handles it without further changes.
- **`apps/bot-worker/src/debug/local-debug-ws.ts`** —
  the debug WS handler already maintains a rolling buffer
  (`recentFinals`). The MeetingSummarizer slots into the same
  runtime state. The handler is where pause-debounce timing lives.
- **`packages/engine/src/relevance/prompt.ts`** —
  contains `buildRelevanceSystem` + `buildRelevanceTool`. Both grow
  to consume optional context inputs.

### Institutional Learnings

- **Anthropic prompt-cache floor**: Haiku 4.5 has a 4096-token
  minimum cacheable prefix (~16K chars). The summarizer's system
  prompt will be smaller than this — caching is unlikely to help.
  That's fine; the summarizer fires once per ~60s, not per-utterance,
  so non-cached prefix cost is bounded.
- **Tool-use enforces output shape**: the relevance classifier's
  approach (Anthropic tool-use to force structured output) is more
  reliable than asking Claude to emit JSON in text. The summarizer
  should mirror this — `buildSummarizerTool` defines the schema, the
  model fills in field values.
- **The recent-context fix landed in the same session as this plan**:
  changes from commit `95a7029` (engine + bot-worker + portal,
  context-chained synthesis + fragment merge + supersede signal).
  This plan extends that work; it does not reinvent it.

### External References

- Anthropic tool-use docs cover the JSON-schema enforcement pattern
  used here.

---

## Key Technical Decisions

- **Summarizer = new Anthropic-call class, mirrors
  `AnthropicRelevanceClassifier` shape**. Tool-use enforces the
  hybrid schema. Same key + model env vars as synth / classifier
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`).

- **`key_terms` expand the EMBEDDING query, not the synthesis
  prompt** (resolves origin Open Question #2). Rationale: project-
  specific nouns mentioned earlier in the meeting boost retrieval
  recall for short follow-up utterances ("about the auth flow"
  becomes "about the auth flow Supabase OAuth Google" when key_terms
  is `["Supabase OAuth", "Google SSO"]`). The synthesizer already
  gets the same vocabulary via the `summary` prose; passing
  `key_terms` again would be redundant token tax.

- **Prior-summary carry-forward**. The summarizer's input each call
  is `{ prior_summary, recent_transcript_window }`. Without
  carry-forward, content evicted from the 20K-char transcript window
  (covers ~27 min) is lost — by minute 70 of a meeting, the
  summarizer can't see minute 5 anymore, and R2 silently fails for
  meetings past ~30 min. Prompt instructs Claude to merge:
  "Preserve facts from `prior_summary` that are no longer in
  `recent_transcript`; integrate new content; resolve contradictions
  in favor of the more recent transcript." Adds ~300 input tokens
  per call after the first; bounded growth.

- **Mid-stream summary refresh is non-coordinated**. The synthesizer
  captures whatever summary is in runtime state at recentContext-
  build time (synchronously, BEFORE the synthesis call begins). If
  a refresh lands mid-stream, the in-flight call continues with the
  prior summary (consistent — no torn read). The next synthesis call
  picks up the new one. No locking, no debounce-on-summary-side.
  **Invariant**: read `lastSummary` once, at recentContext
  construction; do NOT re-read inside the pipeline.

- **Classifier contract repackages to single options object**.
  `classify(utterance, signal?)` becomes
  `classify(utterance, options?)` where `options: { signal?, context? }`.
  Pre-production status means we don't carry the backward-compat
  burden — the three existing call sites are migrated in U4 as
  one-line edits each.

- **Cold-start: first summary fires aggressively, subsequent on
  normal cadence**. The first summary uses lower thresholds: N=5
  utterances OR M=30s OR D=8s (vs subsequent 15/120/10). Most
  meetings establish their framing topic in the first 1-2 minutes;
  waiting 120s for the first summary means the framing context
  isn't available when it matters most. After the first summary
  fires, cadence reverts to the steady-state defaults.

- **Summarizer reuses the existing Anthropic consent grant**.
  Pre-production status means consent enforcement is still flexible;
  for V1, the summarizer is treated as the same use-kind as
  synthesizer + classifier (all share the same `ANTHROPIC_API_KEY`
  and the same downstream consent gate). If the consent module
  later enumerates uses by specific scope (`synthesis`, `relevance`,
  `summarizer`), that's an additive change.

- **V1 wires BOTH pipelines (debug + Recall production) via a shared
  runtime module**. Earlier draft of this plan deferred the Recall
  path to a follow-up; that left R1/R2 — the production success
  criteria — unmet for real meetings. The shared module
  (`apps/bot-worker/src/summarizer-runtime.ts`) holds the rolling
  buffer, pause-debounced trigger, and lastSummary state. The debug
  pipeline (U2 + downstream) wires it for WS-event broadcast; the
  Recall pipeline (U7) instantiates the same module in
  PerMeetingRuntime and consumes lastSummary for context. No
  divergence to mitigate later; the daemon-vs-bot-worker risk row is
  removed.

---

## Open Questions

### Resolved During Planning

- **key_terms scope** (origin Open Question #2): EMBEDDING-only.
  Synthesizer gets vocabulary via the prose summary.
- **Cadence defaults**: N=15 utterances, M=120s, debounce=10s
  (carried from origin D1).
- **Hard rate cap**: 1 summary per 60s wall-clock (origin D6).
- **Transcript cap**: 20K chars sliding window when summarizing
  (origin D6).
- **Mid-stream refresh**: non-coordinated; in-flight calls keep the
  prior summary.
- **Where V1 wires**: BOTH debug AND Recall pipelines, via shared
  `MeetingSummarizerRuntime` module. U7 wires the Recall path.

### Deferred to Implementation

- **Exact summarizer prompt shape** (origin Open Question #1). Few-
  shot count, refusal conditions, format-tightening notes. The debug
  page visibility (U6) is the iteration surface — expect 2-3 passes
  of prompt iteration during U2/U6.
- **Whether to also pass `open_questions` to the synthesizer**.
  Today's plan only passes them to the classifier. May want to feed
  them into the synthesizer as "context hints" too. Worth observing
  live-test behavior before deciding.
- **The classifier prompt's exact phrasing for context-aware
  judgment**. Today the prompt asks "is this utterance substantive?"
  With context, it becomes "given the meeting so far, does this
  utterance make sense as a thing to pass along?" Wording matters;
  iterate.
- **Whether the summarizer should run on an interval timer vs
  recompute on every check**. A setInterval feels cleaner; on-event
  triggers feel more correct. Either works.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Data flow

    ┌──────────────────────────────────────────────────────────┐
    │ Bot-worker WS runtime (per-session state)                │
    │   recentFinals: [{text, at}, ...]   ← rolling buffer    │
    │   fullTranscript: string             ← capped sliding   │
    │   lastSummary: MeetingSummary | null                     │
    │   lastSummaryAt: number                                  │
    └──────────────────────────────────────────────────────────┘
                            │
                            ▼
       on each final utterance + on pause-debounce timer:
                            │
                            ▼
       trigger check: N finals OR M sec since last summary,
                      AND most-recent utterance ≥ D sec old,
                      AND wall-clock ≥ 60s since last call
                            │
                            ▼
       run AnthropicSummarizer.summarize(transcript)
       → MeetingSummary { summary, current_topic, open_questions, key_terms }
                            │
                            ▼
       update lastSummary atomically
                            │
                            ▼
       broadcast to WS (debug page): { type: "summary", summary }


    ┌──────────────────────────────────────────────────────────┐
    │ Per-utterance pipeline (already exists, extended):       │
    └──────────────────────────────────────────────────────────┘
       final utterance arrives
                            │
                            ▼
       maybe-classify (relevance):
         classifier.classify(utterance, { context: {
           current_topic: lastSummary?.current_topic,
           open_questions: lastSummary?.open_questions ?? [],
         }})
                            │
                            ▼ surface
       build embedding query:
         text = utterance + " " + (lastSummary?.key_terms ?? []).join(" ")
                            │
                            ▼
       retrieve cards (unchanged)
                            │
                            ▼
       synthesize:
         recentContext = [
           lastSummary?.summary,   ← prose overview (oldest)
           ...last 5 finals          ← recent turns (newest)
         ].filter(present)


### Summary schema (tool-use enforced)

    interface MeetingSummary {
      summary: string;          // 1-3 sentence prose
      current_topic: string;    // short label
      open_questions: string[]; // verbatim Q's raised but unresolved
      key_terms: string[];      // project nouns, identifiers
    }

The tool's input JSON schema requires all four fields. Claude is
prompted to emit `summary` covering "what has the meeting been about
so far"; `current_topic` capturing the active thread; `open_questions`
listing what's been asked but not answered; `key_terms` extracting
project-specific identifiers the conversation has used (filenames,
plan U-IDs, library names, etc.).

---

## Implementation Units

- [ ] U1. **Engine: `AnthropicSummarizer` module + prompt + tool**

**Goal:** New `AnthropicSummarizer` class in
`packages/engine/src/summarize/` that mirrors the relevance-classifier
shape — tool-use enforced output, same constructor options pattern,
returns a `MeetingSummary` object. This is the foundation; everything
else consumes it.

**Requirements:** R7, R11 (refusal handling), R4 (latency budget).

**Dependencies:** None.

**Files:**
- Create: `packages/engine/src/summarize/contract.ts` — exports
  `MeetingSummary` interface, `Summarizer` interface, error types
  (`SummarizerProviderError` paralleling existing patterns).
- Create: `packages/engine/src/summarize/prompt.ts` — exports
  `buildSummarizerSystem`, `buildSummarizerTool`, `parseSummarizerToolUse`.
- Create: `packages/engine/src/summarize/anthropic.ts` — exports
  `AnthropicSummarizer` class.
- Create: `packages/engine/src/summarize/index.ts` — barrel exports.
- Modify: `packages/engine/src/index.ts` — re-export from
  `./summarize/index.js`.
- Modify: `packages/engine/package.json` — add `./summarize` subpath
  export (mirrors the existing `./synthesize`, `./relevance` entries).
- Test: `packages/engine/test/summarize/prompt.test.ts` — parser +
  tool-input shape.
- Test: `packages/engine/test/summarize/anthropic.test.ts` — mocked
  fetch, retry behavior, refusal handling (mirror
  `relevance/anthropic-classifier.test.ts`).

**Approach:**
- The summarizer takes `{ prior_summary?, transcript_window }` as
  input (capped 20K chars on the transcript). System message
  describes the role + the tool schema + the carry-forward
  instruction. Prior-summary input is optional (null on first call;
  populated on every subsequent call).
- Tool-use enforces output: Claude must invoke the `emit_meeting_summary`
  tool with all four fields. Parsing reads `content[i].input` for the
  tool_use block. Scan the FULL `content` array (not just `content[0]`)
  — Anthropic may emit narration text before the tool_use block.
- The carry-forward instruction in the system prompt: "When
  `prior_summary` is provided, treat its `summary`, `key_terms`, and
  `open_questions` fields as historical context that may NOT be
  present in the current `transcript_window` but is still part of
  the meeting's arc. Preserve facts from `prior_summary` that
  haven't been superseded; integrate new content from
  `transcript_window`. Resolve contradictions in favor of the more
  recent transcript content."
- Refusal: tool not invoked (Claude returns text instead) →
  `SummarizerProviderError('refused', ...)`. Callers retain prior
  summary on this error.
- Retry pattern: mirror `AnthropicRelevanceClassifier`'s exponential
  backoff (existing `maxRetries=4` default).
- No streaming. Summary is small (~300 tokens output); single response.

**Patterns to follow:**
- `packages/engine/src/relevance/anthropic-classifier.ts` for the
  constructor shape + tool-use invocation flow.
- `packages/engine/src/relevance/prompt.ts` for the
  `buildRelevanceSystem` + `buildRelevanceTool` pattern.

**Test scenarios:**
- Happy path: Claude responds with a tool_use block containing all
  four fields → parser returns the typed `MeetingSummary`.
- Edge case: Claude returns text instead of tool_use →
  `SummarizerProviderError('refused')`.
- Edge case: tool_use input is missing a required field (Claude
  misbehavior) → `SummarizerProviderError('bad-request')`.
- Edge case: empty transcript input → caller's responsibility to not
  call summarizer; if it does call, summarizer returns a "no
  meaningful content" refusal.
- Carry-forward: input includes `prior_summary` with `current_topic
  = "auth flow"` + `transcript_window` containing 5 minutes of
  unrelated banter. Output preserves "auth flow" in `summary` /
  `key_terms` even though it's not in the recent window.
- Tool_use scan: Anthropic response has text in `content[0]` and
  tool_use in `content[1]` → parser walks the array and finds the
  tool block.
- Error path: Anthropic 429 with retry-after → backoff per existing
  retry logic; eventual `rate-limit` error if retries exhausted.
- Error path: network error → wrapped as
  `SummarizerProviderError('network-error')`.
- Type test: tsc rejects calling `summarize` with a non-string
  transcript.
- Size cap: caller passes 30K-char transcript → summarizer accepts
  it (the cap enforcement lives in the bot-worker runtime, not the
  engine; the engine takes whatever it's given).

**Verification:**
- `pnpm --filter @risezome/engine test` passes.
- `pnpm --filter @risezome/engine typecheck` passes.
- Manual smoke (during U2 wiring): point the summarizer at a 5-minute
  recorded transcript fragment, verify all four fields populate
  sensibly.

---

- [ ] U2. **Bot-worker shared `MeetingSummarizerRuntime` module + debug integration**

**Goal:** Factor the rolling buffer + pause-debounced trigger +
lastSummary state into a shared module both the debug pipeline AND
the Recall pipeline (U7) will instantiate. Wire it into the debug WS
handler; broadcast each new summary as a `summary` event on the WS
(for U6 to render). The Recall path follows the same pattern in U7
using the same module — no divergence.

**Requirements:** R6, R10, R11.

**Dependencies:** U1.

**Files:**
- Create: `apps/bot-worker/src/summarizer-runtime.ts` — new
  `MeetingSummarizerRuntime` class. Constructor takes
  `AnthropicSummarizer` instance + cadence config (N, M, D, hard
  rate cap, transcript char cap) + an `onSummaryUpdated(summary)`
  callback. Exposes `recordUtterance(text)` and `dispose()` methods.
  Owns the rolling buffer, full transcript (capped), pause-debounced
  setTimeout, the in-flight guard, and the lastSummary slot. Pure
  bot-worker concern (not engine) because runtime state isn't useful
  outside per-meeting orchestration.
- Modify: `apps/bot-worker/src/debug/local-debug-ws.ts` — replace
  the existing inline `recentFinals` + `fullTranscript` logic with
  a `MeetingSummarizerRuntime` instance. Each `engine.on('final')`
  calls `runtime.recordUtterance(text)`. The runtime's
  `onSummaryUpdated` callback wraps `send(socket, {type: 'summary',
  summary})`. Dispose on WS close.
- Test: `apps/bot-worker/test/summarizer-runtime.test.ts` (new) —
  the trigger logic factored as a pure-function-capable module
  with synthetic utterance-arrival traces (no real Anthropic
  call; mock the summarizer).

**Approach:**
- The shared module exposes `recordUtterance(text)` +
  `getLastSummary()` + `dispose()`. Lifecycle: instantiated when the
  meeting starts (debug WS connect; Recall WS connect — see U7),
  disposed on close. Holds NO global state — pure per-instance.
- Per-call behavior of `recordUtterance(text)`:
  - Push into rolling buffer (last 5 finals within 60s).
  - Append to fullTranscript; trim head if over 20K chars.
  - Re-arm a rolling `setTimeout` for D ms (the pause-debounce); the
    timer's callback re-checks trigger conditions:
    - Counter: utterances since last summary ≥ N (15) OR time ≥ M (120s)
    - AND wall-clock since last call ≥ 60s (hard rate cap)
    - AND no in-flight summarizer call
  - If all hold: fire the summarizer (async, fire-and-forget).
    Snapshot transcript at fire time (`.slice(0)` the string so the
    in-flight call can't see later mutations). Pass the current
    `lastSummary` as the `prior_summary` input so Claude can
    carry-forward facts that aged out of the transcript window. On
    success: update lastSummary atomically + invoke the host's
    `onSummaryUpdated` callback. On error: log + retain prior
    lastSummary.
- **Re-arm-on-skip rule (T1 from review):** if the timer fires but
  in-flight-guard rejects, the next utterance's setTimeout-arm
  picks the trigger back up. If no further utterances arrive, no
  stale state persists. The pause-debounce + count/time fallback
  together guarantee a summary fires within
  `max(D, M) + wall_clock_cap` of an active conversation.

**Patterns to follow:**
- Existing `recentFinals` rolling buffer logic at
  `apps/bot-worker/src/debug/local-debug-ws.ts:engine.on('final')`
  is the starting reference — but factor it out, don't inline copy.
- Async fire-and-forget pattern already used for `runDebugPipeline`.

**Test scenarios:**
The trigger logic is now in a testable module. Mock the
`AnthropicSummarizer` so the runtime can be exercised against
synthetic utterance-arrival traces without real API calls.
- Pause-debounced trigger: utterances arriving at 1/sec for 20s,
  then a 12s pause → exactly one summarizer call at the end of the
  pause.
- Count fallback: 15 utterances in 30s, no pause → count trigger
  fires (subject to rate cap).
- Time fallback: 2 utterances over 121s → time trigger fires.
- Hard rate cap: rapid talker, 30 utterances in 30s, the count
  trigger hits at utterance 15 → summarizer fires once;
  utterance 30 is within 60s wall-clock → trigger does NOT fire
  again (capped).
- In-flight guard: mock summarizer takes 5s; second trigger arrives
  at 2s → second fire is skipped; the next utterance after the
  summary completes re-arms the timer (no permanent skip).
- Transcript overflow: append 25K chars → head trimmed to 20K, most
  recent retained.
- Summarizer refusal: mock throws `SummarizerProviderError('refused')`;
  prior `lastSummary` retained unchanged; no host callback fires.
- Dispose: `runtime.dispose()` clears pending setTimeout; subsequent
  `recordUtterance` is a no-op.

**Verification:**
- Bot-worker starts and serves WS. Connecting to `/local-debug/<jwt>`
  and speaking through the sidecar for >2 minutes produces a `summary`
  WS event with non-empty fields.
- `pnpm --filter @risezome/bot-worker typecheck` passes.

---

- [ ] U3. **Synthesizer integration: prepend summary prose to `recentContext`**

**Goal:** When `lastSummary` is non-null at synthesis time, prepend
its `summary` prose to the `recentContext` array as the oldest
entry. The synthesizer's `buildUserMessage` already labels the
list as "Recent transcript (oldest first)" so the prose slots in
seamlessly.

**Requirements:** R8.

**Dependencies:** U2.

**Files:**
- Modify: `apps/bot-worker/src/debug/local-debug-ws.ts` —
  `runDebugPipeline` call site that builds `recentContext`.

**Approach:**
- At call site, build `recentContext` as
  `[lastSummary?.summary, ...recent5Finals].filter(Boolean)`.
- Read `lastSummary` synchronously ONCE at the call-site (just
  before invoking `runDebugPipeline`). The constructed array is
  passed into the pipeline as `recentContext: readonly string[]`.
  Do NOT re-read `lastSummary` inside the pipeline. This is the
  load-bearing invariant for "non-coordinated mid-stream refresh"
  (Key Technical Decisions): if a new summary lands during an
  in-flight synthesis call, the call must continue with the prior
  summary it captured at start. Re-reading mid-pipeline would
  introduce a torn-read.
- No engine change — the `recentContext` plumbing already exists from
  the prior commit.
- Cold start: when `lastSummary` is null, behavior is unchanged from
  today's recent-5-only context.

**Patterns to follow:**
- The existing `recentContext` construction in
  `apps/bot-worker/src/debug/local-debug-ws.ts engine.on('final')`.

**Test scenarios:**
- Happy path: with `lastSummary` populated, the synthesizer's user
  message contains the summary prose as the first numbered entry
  followed by recent finals. (Verified by inspecting the
  `local-debug.synthesis.start` log line which records
  `recentContextSize`.)
- Cold start: `lastSummary === null` → `recentContext` length =
  `min(5, recentFinals.length)`. No regression on first 2 min.
- Edge case: `lastSummary.summary` is empty string → filtered out by
  `.filter(Boolean)`; no empty-string entry leaks into the prompt.

**Verification:**
- Manual: ask a question 3+ minutes into a meeting that references a
  prior topic; the synthesis answer reflects the prior context.

---

- [ ] U4. **Relevance classifier: repackage contract to options object + add `context`**

**Goal:** `RelevanceClassifier.classify` repackages its second arg
from `signal?: AbortSignal` to `options?: { signal?, context? }`.
The Anthropic implementation's prompt grows to consume `context`
when present. This is a one-line-per-call-site breaking change at
three known call sites; the plan migrates all three in this unit.

**Requirements:** R1, R9.

**Dependencies:** U1 (`MeetingSummary` type — `context` shape is a
subset of `MeetingSummary.current_topic` + `.open_questions`).

**Files:**
- Modify: `packages/engine/src/relevance/contract.ts` — repackage
  `RelevanceClassifier.classify` second arg from `signal?` to
  `options?: ClassifyOptions` where `ClassifyOptions = { readonly
  signal?: AbortSignal; readonly context?: { readonly
  current_topic?: string; readonly open_questions?: readonly
  string[] } }`. Export `ClassifyOptions`.
- Modify: `packages/engine/src/relevance/anthropic-classifier.ts` —
  read `options.signal` + `options.context`; build user message with
  context when present.
- Modify: `packages/engine/src/relevance/prompt.ts` — extend the
  user-message builder (or system prompt) to include context when
  present.
- Modify: `apps/bot-worker/src/retrieval.ts:433` — call site
  migration: `classify(args.utterance, controller.signal)` becomes
  `classify(args.utterance, { signal: controller.signal })`.
- Modify: `apps/daemon/src/retrieve/pipeline.ts:309` — same migration:
  `classify(latestUtterance, { signal: relevanceController.signal })`.
- Modify: `packages/engine/test/relevance/anthropic-classifier.test.ts`
  — call sites at line ~171 (and others) migrated to the options
  shape.
- Test: `packages/engine/test/relevance/prompt.test.ts` — context
  branches (with vs without context, output diffs).
- Test: `packages/engine/test/relevance/anthropic-classifier.test.ts`
  — context-passing assertions on mocked fetch payload.

**Approach:**
- The signature change is a single mechanical breaking change at
  three call sites. Modern TS API convention (think `fetch` options,
  `AbortSignal.timeout` consumers) favors a single options object
  over positional optional args because optional-position-2 +
  optional-position-3 creates parameter-order ambiguity (you can't
  pass position 3 without passing position 2). The repackage is the
  principled fix; the migration cost is 3 single-line edits.
- The Anthropic prompt's current framing ("is this utterance
  substantive?") shifts to "given the meeting context below, does
  this utterance make sense as a question/statement worth surfacing
  context for?" — exact wording is implementation-time iteration
  (deferred question).
- Output shape unchanged: `RelevanceResult` is still `surface` /
  `skip{confidence, reason}`. The new context only changes the
  judgment quality, not the output type. (The brainstorm origin's
  success-criteria wording mentions `clearly_substantive` —
  that's the heuristic's 3-state taxonomy, not the classifier's.
  The plan's terminology is the authoritative one here.)
- `classifyRelevanceHeuristic` in `relevance/heuristic.ts` is NOT
  modified — it's a separate pure function with a different return
  type (`RelevanceHeuristicResult`, 3-state) and doesn't implement
  the `RelevanceClassifier` interface. Earlier draft of this plan
  conflated them; corrected here.

**Execution note:** test-first for the contract change — write the
new signature in the test before flipping the implementation. This
catches breaking-change footguns early.

**Patterns to follow:**
- The existing tool-use invocation in
  `packages/engine/src/relevance/anthropic-classifier.ts`.
- Modern TS options-object conventions (e.g., `fetch(url, init)`).

**Test scenarios:**
- Happy path: `classify(utterance, { context: { current_topic: 'auth
  flow', open_questions: ['how does SSO work?'] } })` →
  `RelevanceResult` returned; the system+user messages sent to
  Anthropic include the context.
- Migration: `classify(utterance, { signal: controller.signal })` is
  the new shape; verify the signal is honored on abort.
- Coherence-in-context: with `current_topic = 'LLM usage'`, a
  classifier called on "in the app and where in the code base are
  they" returns `surface` (not `skip`). Covers AE1 (R1 success
  criterion #1).
- Filler with context: with any context, "uh… so… anyway" returns
  `skip` with high confidence. Context doesn't override clear filler.
- Context omitted: `classify(text, { signal: ... })` (no context
  field) behaves identically to today's no-context classifier — same
  prompt, same output distribution.
- Type test: TS rejects `classify(text, controller.signal)` (the
  legacy shape) at compile time — that's the load-bearing migration
  signal.

**Verification:**
- `pnpm --filter @risezome/engine test` passes.
- `pnpm --filter @risezome/engine typecheck` passes.
- `pnpm --filter @risezome/daemon typecheck` passes (call site
  migrated).
- `pnpm --filter @risezome/bot-worker typecheck` passes (call site
  migrated).

---

- [ ] U5. **Bot-worker debug: pass context to classifier + key_terms to embedding query**

**Goal:** The debug pipeline calls the relevance classifier with the
`lastSummary`-derived context, and concatenates `key_terms` onto the
embedding query when available.

**Requirements:** R1, R2 (long-range memory test relies on key_terms
boosting retrieval).

**Dependencies:** U2, U4.

**Files:**
- Modify: `apps/bot-worker/src/debug/local-debug-ws.ts` — relevance
  classifier call site (if/when added) + embedding query
  construction in `runDebugPipeline`.

**Approach:**
- The debug pipeline doesn't currently invoke the relevance
  classifier (the Recall pipeline does). Add an optional classify
  step before retrieval: if classifier returns `skip` above the
  configured confidence threshold, emit a `retrieval-skip` event and
  return; else continue.
- Embedding query: `text = utterance + (key_terms.length > 0 ? ' ' +
  key_terms.join(' ') : '')`. No-op when no summary exists.
- The classifier call is a NEW Anthropic call per utterance. To
  match the Recall pipeline's cost behavior, gate it behind a
  threshold: only call when the cheap heuristic returns `ambiguous`
  (mirrors the daemon's existing pattern).

**Patterns to follow:**
- Existing relevance flow in
  `apps/bot-worker/src/retrieval.ts maybeRetrieveAndEmit` — heuristic
  first, LLM only on ambiguous.

**Test scenarios:**
- Happy path with context: classifier sees `current_topic` +
  `open_questions`, returns `surface`, pipeline continues. Test via
  inspecting the WS-emitted log line that records what was passed.
- Skip path: classifier returns `skip` with confidence above
  threshold → pipeline emits `retrieval-skip {reason:
  'classifier-skip'}` event, no embedding call, no synthesis.
- Cold start: `lastSummary === null` → classifier called without
  context; behavior matches today's daemon.
- Embedding-query boost: `key_terms = ['Supabase OAuth']` →
  embedding payload includes both the utterance text and the key
  terms; verify by intercepting the Voyage call in test (or via the
  debug log line that records the query text).
- key_terms empty array: no concatenation; query is just the
  utterance.

**Verification:**
- Live test (covered by U6 debug page): on the same recorded test
  session, the second of two split utterances ("in the app and
  where in the code base are they" after "are any LLMs leveraged")
  is no longer dropped as filler.

---

- [ ] U6. **Debug page: render current summary in a panel**

**Goal:** Add a fourth column (or a top strip) to the `/debug/live-mic`
page showing the current rolling summary — prose, current_topic,
open_questions, key_terms — updated live as the WS emits `summary`
events. Lets the user iterate on the summarizer prompt by watching
its output evolve.

**Requirements:** R12.

**Dependencies:** U2 (the bot-worker emits the `summary` event).

**Files:**
- Modify: `apps/portal/app/(authed)/debug/live-mic/_client.tsx` — add
  state for `currentSummary`, handle the `summary` WS event, render
  the new panel.

**Approach:**
- Add a top strip above the three columns (utterances / retrievals /
  syntheses) showing:
  - Current topic (large)
  - Summary prose (small)
  - Open questions (bullet list)
  - Key terms (chips)
  - "Updated Xs ago" timestamp
- The summary panel is dev-focused: dense, monospace, no chrome
  beyond a border.
- When no summary has fired yet, show "No summary yet — first
  refresh after 2 minutes or 15 utterances." so the user knows
  it's intentional, not stuck.

**Patterns to follow:**
- Existing 3-column layout structure in
  `apps/portal/app/(authed)/debug/live-mic/_client.tsx Panel`
  component.

**Test scenarios:**
- Happy path: receiving a `{type: 'summary', summary, at}` WS event
  updates `currentSummary` state; panel renders the four fields.
- Empty state: with `currentSummary === null`, the panel shows "No
  summary yet — first refresh after 30 seconds or 5 utterances" copy
  so the user knows it's intentional, not stuck.
- Update: a second `summary` event replaces the prior state; "Updated
  Xs ago" timestamp resets.
- Stale-data edge: the panel's "Xs ago" indicator updates on a 1s
  interval (or on render); if the timestamp is older than 5 minutes,
  visually de-emphasize (muted color) so the user notices staleness
  without action.

**Verification:**
- Start a debug session, speak for 2+ minutes, watch the summary
  panel populate. Reload the page mid-session → the panel should
  show "No summary yet" because the WS reconnects fresh (no
  persistence; expected behavior).

---

- [ ] U7. **Bot-worker Recall production path: instantiate runtime + read summary for context**

**Goal:** The Recall WS pipeline (`apps/bot-worker/src/retrieval.ts
maybeRetrieveAndEmit`) gains the same summarizer integration as the
debug pipeline. Per-meeting runtime instantiates a
`MeetingSummarizerRuntime` (from U2's shared module); each finalized
utterance is recorded; the retrieval+synthesis pipeline reads
`lastSummary` for classifier-context, embedding-query key_terms
boost, and synthesizer recentContext prose. R1 + R2 (production
success criteria) actually hold for real Recall meetings after this
unit lands.

**Requirements:** R1, R2, R8, R9 (applies them to the production
path, not just debug).

**Dependencies:** U1, U2 (shared runtime module), U3 (recentContext
shape), U4 (classifier contract), U5 (debug pattern as reference).

**Files:**
- Modify: `apps/bot-worker/src/index.ts` — `PerMeetingRuntime`
  gains a `summarizer: MeetingSummarizerRuntime` field. Instantiate
  when the runtime is created in the WS `wsHandler`. Dispose when
  the meeting ends (POST /meetings/:id/end handler).
- Modify: `apps/bot-worker/src/retrieval.ts` — in
  `maybeRetrieveAndEmit`:
  - Call `runtime.summarizer.recordUtterance(args.utterance)` per
    invocation.
  - Read `runtime.summarizer.getLastSummary()` at retrieval-build
    time.
  - Pass `context: { current_topic, open_questions }` into the
    `classify()` call at line 433 (new signature from U4).
  - Concat `lastSummary.key_terms` onto the embedding-query text
    (mirror U5's debug-side approach).
  - Build `recentContext` for the synthesizer with
    `[lastSummary.summary, ...recent-finals].filter(Boolean)`
    (mirror U3's debug-side approach).
- Test: `apps/bot-worker/test/retrieval.test.ts` (if exists; add if
  not) — mock the summarizer runtime, verify retrieval pipeline
  reads lastSummary correctly when populated and falls back
  gracefully when null.

**Approach:**
- Same patterns as U2/U3/U5 in debug; this is the production
  mirror. The shared module from U2 means no code duplication —
  the Recall path instantiates the same class.
- No WS broadcast of the summary in Recall (unlike debug). The
  summary is internal context; the user-facing live page already
  shows synthesis output. If a future feature wants the summary
  surface, it adds a Realtime broadcast in a new unit (gated on the
  identity-drift Risks-table decision; see H2 fix below).
- Cold-start grace applies: first ~2 minutes of a Recall meeting,
  `lastSummary` is null; classifier called without context;
  recentContext carries only the last 5 finals. Same behavior as
  today's production path. No regression.

**Patterns to follow:**
- U2's `MeetingSummarizerRuntime` instantiation + `recordUtterance`
  pattern.
- U3's `recentContext` construction (read lastSummary atomically at
  build site, NOT inside the synthesis call).
- U5's classifier-context + key_terms expansion.
- Existing `PerMeetingRuntime` lifecycle in
  `apps/bot-worker/src/index.ts` — runtime created on WS connect,
  disposed on POST /meetings/:id/end.

**Test scenarios:**
- Happy path: Recall pipeline records 15 utterances, the runtime
  fires a summarizer call; subsequent retrieval at utterance 16
  passes context + key_terms + summary prose through to synthesizer.
- Cold start: first 5 utterances of a Recall meeting, no summary
  yet → classifier called without context, embedding-query has no
  key_terms boost, recentContext is just-finals. Matches today's
  behavior; no regression.
- Lifecycle: WS reconnect creates a fresh runtime (existing pattern
  in U3's `runtime.created` log line); old runtime's summarizer
  setTimeouts cleared by the prior dispose call.
- Pin/dismiss / cardRetracted unchanged: summarizer doesn't affect
  these paths.

**Verification:**
- `pnpm --filter @risezome/bot-worker typecheck` passes.
- `pnpm --filter @risezome/bot-worker test` passes.
- Manual: run a real Recall meeting (or the local-debug debug page
  AND a parallel Recall session) past minute 3; verify the
  Recall-side `synthesis.done` log line shows
  `recentContextSize > 5` (proves summary prose is in there) and
  the relevance classifier prompt includes the new context fields.
- **R1 verification** (coherence-in-context, owned by U7): on the
  production Recall path, sequence "are any LLMs leveraged" →
  pause → "in the app and where in the code base are they" → the
  second utterance classifies `surface` (not `skip`) and the
  resulting synthesis is on-topic. Same test that U5 runs on the
  debug pipeline, executed on the production path.
- **R2 verification** (long-range memory, owned by U7): a real
  meeting past minute 25 where an utterance references a topic
  established at minute 5. With prior-summary carry-forward (from
  U1) and `key_terms` expansion of the embedding query (from U5
  pattern, mirrored in U7), retrieval surfaces topic-relevant
  sources. The U7 manual smoke is the load-bearing R2 test.

---

## System-Wide Impact

- **Interaction graph:** The new summarizer adds a third Anthropic
  call type per session alongside the existing
  synthesizer + classifier. All three share the same key/model env
  vars and consent grant. Verify the existing consent module's
  scope grant covers "summarizer" as a recognized use or extend it.
- **Error propagation:** Summarizer failure is non-fatal — the
  pipeline retains the prior summary or runs with `lastSummary =
  null`. No upstream signal to the page beyond the `summary` event's
  absence.
- **State lifecycle risks:** `lastSummary` is updated atomically (a
  single assignment to a `let` binding inside the WS handler
  closure). No locking needed. In-flight synthesis calls captured
  the prior summary in their `recentContext`; the next synthesis
  picks up the new one. No torn-read risk.
- **API surface parity:** The classifier contract extension is
  additive and backward-compatible. The daemon
  (`apps/daemon/src/retrieve/pipeline.ts`) doesn't need changes; it
  continues to call `classify(utterance, signal)` and gets the
  legacy isolated-utterance behavior. When the production Recall
  pipeline picks this up (deferred unit), it'll start passing
  context like the debug pipeline does.
- **Integration coverage:** The classifier-with-context behavior +
  the pause-debounced trigger timing both have observable behaviors
  that unit tests can't fully validate. Manual smoke through the
  debug page is the primary verification surface; U6's debug panel
  is the iteration scaffolding for this.
- **Unchanged invariants:** The existing `recentContext` plumbing
  shape stays exactly as the prior commit defined it — `string[]`
  with "oldest first" semantics. The summary prose is just another
  entry in that list, not a new field. `RelevanceResult` shape and
  the `surface` / `skip` decision contract are unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Summarizer prompt is hard to dial in — Claude emits vague summaries, hallucinated topics, or misses carry-forward content | U6 debug page is the iteration surface; expect 4-6 passes of prompt refinement (the existing classifier prompt is 600+ lines of iterated examples — the summarizer's four-field structured output is comparable complexity). Tool-use schema enforcement bounds the format failure modes. |
| Classifier becomes over-eager to `surface` when context is present, raising synthesis call count | Watch the `surface` rate via existing logs after U5 lands. If `surface` rate jumps materially (>2x baseline), tighten the classifier prompt's confidence calibration. |
| Pause-debounce never fires in a fast-talking meeting (no 10s pause) | Hard rate cap (60s wall-clock) acts as fallback. The count-trigger (N=15 utterances) fires regardless of pause-debounce after enough finals. Tests in U2 exercise the steady-talker path. |
| `key_terms` expansion of the embedding query may DEGRADE retrieval (Voyage embeddings are trained on natural sentences, not keyword bags) | Ship behind an env flag for first live test. Compare retrieval similarity-score distributions on a recorded test session with and without expansion. If quality drops, disable + iterate. The risk here is real — naive keyword-stuffing is known to under-perform vs HyDE-style sentence expansion. |
| Identity drift: once the rolling-summary artifact exists, the cost to surface it on the live page is low and the product pressure to do so is real ("show me what the meeting has been about") | Pre-production framing means this isn't blocking V1, but worth a structural barrier before the product has real users: keep the debug-page summary panel deliberately styled as diagnostic (monospace, no chrome) so promoting it is visibly wrong; the Recall path (U7) doesn't broadcast the summary at all (internal-only). Revisit when the product has users and a "meeting context" surface request lands. |

---

## Documentation / Operational Notes

- After U2 lands, the bot-worker's `synthesis.done` log line should
  gain a `summary_chars: N` or `summary_age_ms: T` field so we can
  correlate summary freshness with synthesis quality in post-test
  review.

### Cost math (realistic, not the loose `<$1/hr` ceiling)

Anthropic Haiku 4.5 pricing (~$1/M input + $5/M output as of late
2025 / early 2026). Per-call inputs:

- System prompt + tool schema: ~1.5K tokens
- Prior summary (after first call): ~300 tokens
- Transcript window (20K chars cap): ~5K tokens
- **Total input**: ~6.5-7K tokens
- **Output** (tool_use JSON): ~300 tokens

**Per-call cost**: 7K × $1/M + 300 × $5/M ≈ $0.0085

**Per-hour ceilings:**
- Hard rate cap (1 call / 60s = 60 calls/hr): **$0.51/hr** worst case
- Typical pause-debounced cadence (15-20 calls/hr): **$0.13-$0.17/hr**

The brainstorm's `<$1/hr` ceiling is a safety bound, not a target.
Drift detection should calibrate against the realistic-typical
($0.20/hr at 2x typical) — not the loose ceiling. If aggregate
spend grows past $0.20/hr/meeting, investigate before it hits $1.
- The brainstorm doc explicitly flags identity-drift concerns
  (user-facing summary surface = "AI meeting assistant" territory).
  When V1 lands, add a comment in
  `apps/portal/app/(authed)/debug/live-mic/_client.tsx`'s summary
  panel noting "DEBUG-ONLY — DO NOT promote this panel to the live
  page without revisiting the identity-drift brainstorm decision."
- A `docs/solutions/` entry capturing the pause-debounced cadence
  pattern + tool-use enforcement choice is worth adding once V1
  proves the shape — both are reusable for future "periodic
  Claude-derived state" features.

---

## Sources & References

- **Origin document:** `docs/brainstorms/rolling-meeting-summary-requirements.md`
- **Prior context (same session):** `docs/brainstorms/live-page-synthesis-first-requirements.md` and `docs/plans/2026-05-31-001-feat-live-page-synthesis-first-plan.md`
- Related code:
  - `packages/engine/src/relevance/anthropic-classifier.ts` (pattern for new summarizer)
  - `packages/engine/src/synthesize/anthropic.ts` (constructor + retry shape)
  - `apps/bot-worker/src/debug/local-debug-ws.ts` (runtime state, where this plan plugs in)
  - `apps/portal/app/(authed)/debug/live-mic/_client.tsx` (UI surface for U6)
- External docs: Anthropic tool-use schema enforcement docs.
