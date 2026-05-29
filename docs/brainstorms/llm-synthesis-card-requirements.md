---
date: 2026-05-29
topic: llm-synthesis-card
origin: docs/brainstorms/meeting-context-copilot-requirements.md
---

# LLM Synthesis Card

## Problem Frame

Today the HUD surfaces relevant docs as raw cards (issue body excerpts, code snippets, markdown sections). Retrieval is fast and accurate but consumption is not: the user has to skim each card to extract the part that addresses what was just said. Mid-meeting, that scan cost is exactly the cognitive load the product is supposed to eliminate.

A live LLM synthesis on top of retrieval would compress N raw snippets into a 1-3 sentence focused answer tailored to the triggering utterance, while keeping the raw cards below as verifiable sources. The cards remain the source of truth; the synthesis is a viewing aid.

The frame matters: this is *making retrieved sources faster to consume*, not *replacing them with AI generation*. Drifting toward "AI meeting assistant" (a crowded category) would dilute the product's wedge. The synthesis card is a lens over the raw cards, not a substitute for them.

---

## Decisions

The brainstorm settled on five anchor decisions. Each was a chosen option from a four-way comparison; alternatives considered are listed under each decision.

### D1. Output shape: Synthesis card on top + raw cards underneath

The HUD renders a `synthesis` card at the top of the stream containing a focused 1-3 sentence answer plus a sources line. The raw retrieved cards remain below it, unchanged, as verifiable sources. Trust is preserved through provenance; cognitive load drops because the top card is the answer.

*Considered and rejected:* per-card summaries (3× LLM cost, scattered focus), synthesis-only with raw cards hidden (loses verifiability, biggest identity drift), quote highlighting only (deterministic but no genuine generation).

### D2. Trigger: Auto-fire when top result crosses a confidence bar

The synthesizer runs automatically on each retrieval batch *if* the top-ranked card's RRF score crosses a configurable threshold. Weak retrievals (noise from low-confidence queries) skip the LLM call entirely; the user sees raw cards only and there is no spurious synthesis.

This preserves the "passive context" identity (no user action required), controls cost (no LLM call on noise), and is not blocked on the Phase 2 question-detection work.

*Considered and rejected:* fire on every retrieval (burns calls on noise), fire only on detected questions (blocked on U16/U17), on-demand button (breaks passive promise).

### D3. Prompt input: Top-N snippets + the triggering finalized utterance

The LLM receives the top-N retrieved card snippets plus the single most recent finalized utterance that drove the retrieval. The full 30s transcript window is not sent.

This is the minimum context that lets the LLM produce a *query-aware* answer (vs a generic doc summary), while keeping the privacy footprint small — only the immediate utterance that prompted the search leaves the daemon, not surrounding side-chatter.

*Considered and rejected:* snippets only (LLM can't address the question), full 30s window (largest privacy exposure, includes irrelevant chatter), last 2 utterances + speaker ID (overkill for v1).

### D4. Provider: Claude Haiku 4.5

First implementation calls Anthropic's `claude-haiku-4-5`. Reasoning:

- Anthropic is already a recognized provider in the existing consent module — no new consent surface to design
- Strong instruction-following and citation behavior matters for "synthesize without inventing"
- ~1-2s response time fits the in-flight UX budget
- Pricing (~$1 / $5 per 1M tokens) is acceptable at our expected call frequency

The integration goes through a small enough surface that swapping to Gemini Flash or a local model is a future addition rather than a v1 pluggability requirement.

*Considered and rejected:* Gemini 2.5 Flash (cheaper but adds new provider surface), pluggable adapter pattern from day 1 (premature abstraction), local Ollama only (heavy local dep, pushes Phase 2 privacy mode forward into v1).

### D5. In-flight UX: Raw cards immediately, synthesis streams in

Raw cards appear at retrieval time exactly as they do today (sub-second). The synthesis slot above them streams tokens as they arrive from Claude — the user sees the answer being written in real time. If the call fails or times out, the slot stays empty and the raw cards stand alone.

Streaming was preferred over a blocking "pop-in" because the perceived-speed gain is significant when the call takes 1-2s, and the synthesis text is short enough that streaming completes quickly once it starts.

*Considered and rejected:* pop-in (~2s of empty slot), placeholder skeleton (distracting if slow), block raw cards until synthesis ready (kills the real-time feel of the whole HUD).

---

## Defaults

Decisions that didn't need to be hashed out in the brainstorm but are committed defaults for planning:

- **Consent gate.** Synthesis requires the user to have granted `anthropic` consent via the existing consent module. Without the grant: no synthesis, raw cards only, no surprise outbound call.
- **Privacy mode disables synthesis.** When privacy mode is on (Phase 2 work), the synthesizer is skipped regardless of consent. Raw cards remain.
- **Silent fallback.** Any LLM failure (network error, rate limit, timeout, malformed response) results in no synthesis card. Raw cards stand alone. No error toast in the HUD; the daemon logs the failure with a trace ID.
- **Latency budget.** ~5s hard cap on the LLM call. After 5s the synthesis is abandoned — raw cards are the only output.
- **Caching.** Synthesis is cached within a meeting by `(hash(triggering_utterance + sorted_source_doc_ids))`. Debounced re-fires on the same window do not re-call the LLM.
- **Citation scope.** The prompt instructs the LLM to cite only the surfaced sources by their numbered references, and not to add facts beyond what the snippets contain.
- **Telemetry.** The daemon logs each call: call count, prompt tokens, completion tokens, latency, fallback reason if any. Feeds the surfacing-quality telemetry stream (U24 in the plan).
- **Prompt caching.** The Anthropic call uses prompt caching via `cache_control: { type: "ephemeral" }` at a fixed breakpoint between the static prefix and the dynamic body. See the dedicated section below for prompt shape and rationale.

---

## Prompt Caching

The synthesizer uses Anthropic's prompt caching from day one. It maps onto our shape on two axes that both serve the user-facing decisions above.

### Why it's worth committing to up front

**Time-to-first-token (D5 in-flight UX).** D5 chose token streaming over a blocking pop-in because the perceived speed lift matters when the call takes 1-2s. Caching reduces TTFT by roughly an order of magnitude on cache hits (typical 700-1000ms → 100-200ms). Streaming on top of a cached prefix is the configuration the in-flight UX was designed around — the user sees the first token almost immediately and reads the answer as it lands.

**Input-token cost.** 90% discount on the cached prefix's input tokens for every call within the 5-minute TTL window. Meeting cadence (a synthesis call every ~10-30s on average) sits comfortably inside that window, so the prefix re-hits cache continuously through the meeting.

### Prompt shape

```
[ CACHED PREFIX — billed in full once, ~10% thereafter ]
  - System prompt: role, "synthesize only from the provided
    sources, do not invent facts," citation-by-number rule,
    output length budget (1-3 sentences).
  - Few-shot examples: 4-6 (utterance + numbered sources →
    synthesis) pairs that calibrate tone, citation format,
    and refusal behavior when sources don't address the
    question.

[ CACHE BREAKPOINT — cache_control: { type: "ephemeral" } ]

[ DYNAMIC — billed at full rate every call ]
  - The triggering finalized utterance.
  - The top-N retrieved source snippets, numbered.
```

The few-shot examples carry two loads at once: they calibrate output quality *and* push the cached prefix past Haiku's 4096-token minimum for caching to engage. A bare system prompt is ~300 tokens — below the threshold — so caching would be silently no-ops without them.

### Expected impact

Approximate, per typical 30-minute meeting (~30 synthesis calls, ~2500-token cached prefix, ~500-token dynamic body):

- **Cost (input only).** Without caching: ~$0.13. With caching: ~$0.03. ~75% reduction.
- **TTFT.** Without caching: ~700-1000ms. With caching: ~100-200ms on hits.
- **TTL behavior.** First call in a meeting pays full input cost and seeds the cache. Calls within 5 min of the prior call re-hit. The cache cools naturally after the meeting ends.

Planning still owns: exact prompt wording, exact few-shot examples, whether to track a per-meeting cache-hit metric in the U24 telemetry stream.

---

## Success Criteria

The feature is working when:

1. **Confident retrieval produces a synthesis card** at the top of the stream within ~2s of the triggering utterance, with content that directly addresses what was just said.
2. **Synthesis cites only the surfaced raw cards** — no hallucinated sources, no facts that aren't in the snippets.
3. **Weak retrieval skips synthesis cleanly** — when the top card's confidence is below the threshold, the HUD shows raw cards only, no empty synthesis slot, no flicker.
4. **Failures are invisible to the user** — network errors, rate limits, and timeouts produce no synthesis card, no error UI, just raw cards as the fallback. Daemon logs explain why.
5. **Cost per meeting is bounded** — typical 30-minute meeting (10-30 retrievals after debouncing) produces ≤30 synthesizer calls. With prompt caching engaged (cache prefix ≥4096 tokens, hit rate ≥90% after the first call), input cost lands at ~$0.03 / meeting; without caching it would be ~$0.13. Output tokens unaffected.
6. **The synthesis card visually identifies as AI-generated** so users know to verify against the raw sources below it.

---

## Scope Boundaries

### In scope
- One synthesizer behind the Anthropic provider (Claude Haiku 4.5)
- Streaming token delivery from the daemon to the HUD over the existing WS
- Confidence threshold for trigger gating (env-configurable for tuning)
- In-meeting cache keyed on utterance + source set
- Consent-gated invocation (uses existing consent module)

### Deferred for later
- Pluggable provider abstraction (Gemini, OpenAI, local Ollama). Land Anthropic-only first; abstract when the second provider arrives.
- Multi-turn refinement ("explain more about #6"). The synthesizer is single-shot; clicking a card opens the source on GitHub.
- User-tunable synthesis verbosity / style in the HUD. Use a fixed prompt for v1; expose settings only if real signal demands it.
- Post-meeting synthesis cache persistence across sessions. In-meeting cache only for v1.
- Cross-meeting synthesis ("you also discussed this in last week's standup"). Out of scope for v1.

### Outside this product's identity
- Generative Q&A independent of retrieved sources. The synthesizer must only synthesize *what the cards already say*. If retrieval finds nothing, no synthesis happens — the product does not invent answers.
- "AI meeting assistant" framing in copy, naming, or behavior. The card is a *focused view of retrieved context*, not an AI agent.

---

## Dependencies and Assumptions

- The existing consent module (`apps/daemon/src/cli/consent.ts`) already recognizes `anthropic` as a provider and exposes grant/revoke commands. The synthesizer uses the existing pattern unchanged.
- Anthropic API keys are loaded from `.env` (same convention as `VOYAGE_API_KEY` / `DEEPGRAM_API_KEY`).
- The existing retrieval pipeline (`apps/daemon/src/retrieve/pipeline.ts`) already emits `CardEvent` over the WS to the HUD. A new event type (e.g., `synthesis` with streaming partials) extends that surface; the existing card flow is unchanged.
- Streaming token delivery requires extending the HUD WS protocol to handle partial updates to a single synthesis slot. The current protocol assumes events are complete on receipt.
- The "confidence threshold" is a tunable scalar; the exact value is a calibration question, not a brainstorm question. Plan will pick a starting default and document how to adjust it.
- The HUD bundle has headroom for any small additions needed (currently 71 KB / 100 KB ceiling).
- Anthropic's prompt caching feature is generally available on `claude-haiku-4-5`. The 4096-token minimum cacheable prefix size on Haiku is the binding constraint on prompt structure (few-shot examples exist partly to satisfy it). If Anthropic raises or lowers the floor, the prompt structure adjusts but the architecture doesn't.

---

## Open Questions for Planning

These are technical questions that planning will resolve, not product questions:

1. **WS protocol shape for streaming partials.** Do we add a `synthesisDelta` event with `{ synthesisId, deltaText }`, or extend `cardUpdated` with a streaming-text variant? Either works; cleanest pattern wins.
2. **Confidence threshold calibration.** What initial RRF cutoff balances coverage and noise? Likely needs measurement against the dogfood corpus (~10-20 hand-graded queries).
3. **Synthesis card type in the corpus.** Synthesis is ephemeral (not stored); is it modeled as a `CardEvent` variant or a separate `SynthesisEvent`? Affects HUD rendering ergonomics.
4. **Prompt template.** Concrete prompt wording — system prompt text, the 4-6 few-shot example pairs, source numbering convention — is implementation detail for planning. The *shape* (cached prefix + breakpoint + dynamic body) is fixed; the words inside are not.
5. **How does the synthesis interact with `Pin`?** Can the synthesis itself be pinned, or only the underlying raw cards? Probably the latter, but worth confirming during planning.
6. **What happens to the synthesis when `cardRetracted` fires on a source it cited?** Retract the synthesis too? Mark it stale? Likely retract for consistency, but planning should decide.

---

## Origin References

- This brainstorm extends the meeting context copilot defined in `docs/brainstorms/meeting-context-copilot-requirements.md`.
- Plan U17 already anticipates an LLM-in-the-loop pattern for question detection — this synthesis feature can share the provider/consent integration once both land.
- Plan U24 (surfacing-quality telemetry) is the natural home for synthesizer call metrics (token count, latency, fallback rate).
- The existing consent module is the integration surface for the Anthropic provider grant.
