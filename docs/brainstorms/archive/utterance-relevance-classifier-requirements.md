---
date: 2026-05-29
topic: utterance-relevance-classifier
github_issue: https://github.com/Nath5/upwell/issues/16
---

# Utterance-Relevance Pre-Classifier

## Problem Frame

Every finalized utterance from the transcription engine currently triggers the full retrieval pipeline: Voyage embed → hybrid search → emit cards → (when confidence is high enough) Claude synthesis. In real meetings a meaningful fraction of those utterances are not worth surfacing anything for:

- Conversational filler: *"yeah", "right", "ok", "hmm", "let me think"*
- Social / off-topic: *"how was your weekend", "lunch in 10"*
- Acknowledgments: *"good point", "agreed", "that makes sense"*
- Meta-meeting talk: *"where were we", "moving on", "next item"*

Three concrete costs result:

1. **HUD noise.** Cards surface for irrelevant utterances, training the user to ignore the HUD or scroll past genuine matches.
2. **Voyage spend.** Each pipeline run is one embedding call. Even on PAYG the floor accumulates over many meetings; on free tier it is the rate-limiting bottleneck during the meeting itself.
3. **Synthesis spend.** When a noise utterance happens to retrieve at least one card above the confidence threshold, a Claude synthesis call fires too. Wasted money on output the user immediately dismisses.

The existing router classifier (`apps/daemon/src/router/anthropic-classifier.ts`, heuristic-gated by `apps/daemon/src/router/heuristic.ts`) decides between RAG and tool paths for utterances that already warrant a pipeline run. The missing step is *before* that: a pre-classifier that decides whether to run the pipeline at all.

---

## Decisions

The brainstorm settled on the following anchor decisions.

### D1. Conservative skip — filter only obvious filler

The pre-classifier exists to remove unambiguous noise, not to second-guess whether the user would *want* context for an utterance. Target shape: roughly **5–10 surfaces in a 30-minute meeting** of substantive conversation, with the skipped set limited to single-word acknowledgments, conversational filler, social pleasantries, and pure meta-meeting talk. Anything with substantive content runs the pipeline; downstream confidence thresholds and time-windowed dedup handle whether a card actually shows.

The cost asymmetry drives this: a false positive (substantive utterance accidentally skipped) is much worse than a false negative (small talk slipping through and producing an off-target card the user just glances past). The product is meant to feel *present*, not *judgmental*.

*Considered and rejected:* aggressive skip (1–3 surfaces per meeting, skip anything not clearly a question or named-entity reference) — too risky, makes the product feel absent and broken when it misses; surface-everything (~15+) — what we have today, which is the problem this brainstorm exists to address.

### D2. Heuristic-gated LLM, not LLM-on-every-utterance

A fast deterministic heuristic (regex + length checks) makes the obvious calls with zero LLM cost. Only utterances the heuristic flags as *genuinely ambiguous* fire a Claude call. The vast majority of filler is one-word acknowledgments or stock phrases the heuristic catches directly.

This keeps the per-utterance cost floor at zero. The LLM fires only on the residual ambiguous cases, where the additional spend is proportional to the value of the decision.

*Considered and rejected:* heuristic-only (under-filters anything not in the regex set, e.g. paraphrased "I think we'll probably… you know… handle that later"); LLM on every utterance (bundled into the router classifier as `skip / rag / tool`) — pays the LLM cost on every flush and forces a rewrite of the router prompt for no clear gain at this stringency level.

### D3. Separate filler classifier, not bundled into the router

When the heuristic-gated LLM call fires, it lives in its own classifier with its own cached system prompt focused exclusively on filler-vs-substantive judgement. The router classifier stays as it is.

The two decisions are semantically independent: "is this worth surfacing context for" and "does this need a tool vs RAG answer" don't share evidence or context windows in any deep way, and bundling them would couple two semi-orthogonal abstractions. The rare utterance that needs both classifications would pay for two LLM calls (the second only fires when the router heuristic also matches). The frequency is low; the simplification is real.

*Considered and rejected:* bundling into the router (one call when triggered, but requires re-writing the recently-shipped 17k-char router prompt and risks cross-contamination between the two judgements); bundling into the synthesizer (let the LLM decide silence is a valid output — costs the Voyage embed + retrieval regardless, which defeats one of the three motivations).

### D4. Default to surface on ambiguity

Whenever the classifier is uncertain, the API call fails, the heuristic doesn't have a strong signal, or the utterance is a possible fragment — surface. The cost asymmetry from D1 propagates here: the classifier should err on the side of letting the pipeline run rather than hiding what might be a real question.

Concretely this means:
- Heuristic neither-matches-filler-nor-matches-clear-substance → surface (don't fire LLM)
- LLM API error or timeout → surface (don't block the pipeline on a flaky classifier)
- LLM returns low-confidence skip → surface (only skip when LLM says it confidently)
- Short utterance starting with filler but containing content ("yeah so the auth thing") → surface (the prefix doesn't change what follows)

*Considered and rejected:* default to skip on uncertainty (inverts the cost asymmetry; one missed question is more damaging than ten extra cards); defer + buffer (hold the utterance, wait 1–2 seconds for the next one, re-evaluate combined text) — interesting for fragment handling but adds state and latency for a v2-shaped problem; v1 leans on the rolling windowText already concatenating recent finals.

### D5. Telemetry is logs-only in v1

Each skip writes a daemon log line with the utterance text, which gate caught it (heuristic vs LLM), and the reason. No HUD visibility — no skip counter, no inspector, no debug panel. Logs are sufficient to grep after a meeting and evaluate filter quality without polluting the live HUD with noise about *not* surfacing things.

A HUD-level inspector is interesting but the right design depends on what we learn from the logs first; punting it lets the product team see real skip data before committing to UI.

*Considered and rejected:* subtle HUD counter ("N filtered") — adds UI surface area on a feature whose whole point is reducing noise; full inspector panel — over-designed for v1 use case (the user is dogfooding and has terminal access); fully opaque — leaves no way to evaluate whether the filter is doing the right thing.

---

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | A new pre-classifier step runs at the top of `RetrievalPipeline.#evaluate`, before the embed call. |
| R2 | The pre-classifier sees only the latest finalized utterance, not the rolling windowText. Same input shape as the router heuristic. |
| R3 | A fast regex / length-based heuristic decides obvious cases with zero LLM cost. Patterns cover single-word acknowledgments, common filler phrases, social pleasantries, and meta-meeting talk. Exact pattern list is a planning artifact, not a brainstorm decision. |
| R4 | When the heuristic is ambiguous, a Claude call fires on the utterance with a dedicated cached system prompt. The classifier returns `skip` or `surface` plus a confidence score. |
| R5 | The Claude call runs in parallel with the embed call (same pattern as the router). If `skip` lands first, the embed result is discarded and the pipeline returns. If `surface` lands first or after, the pipeline continues. |
| R6 | The skip decision requires high confidence from the LLM. Default behavior on low confidence is `surface`. Threshold is a planning calibration. |
| R7 | Any classifier failure (API error, timeout, missing API key, missing consent) defaults to `surface`. The pipeline is never blocked by a flaky pre-classifier. |
| R8 | Each skip writes a structured daemon log line: `utterance_text`, `gate` (`heuristic` or `llm`), `reason`. No HUD surface. |
| R9 | The pre-classifier reuses the existing Anthropic consent gate. If consent is revoked, only the heuristic runs (LLM-fallback is skipped, ambiguous cases default to `surface`). |
| R10 | The router classifier prompt is unchanged. The pre-classifier is purely additive. |

---

## Scope Boundaries

**In scope for v1:**
- The pre-classifier gate at the top of `RetrievalPipeline.#evaluate`
- Heuristic + Claude-fallback decision path
- Logs-only telemetry
- Integration with existing Anthropic consent gate
- Configurable confidence threshold (env-var or config), tuned during dogfood

**Deferred for later (v2+):**
- `defer` class (hold a fragment, wait for the next utterance, re-evaluate combined text)
- Always-on LLM mode (run the classifier on every utterance instead of heuristic-gated; trade money for tighter filter)
- HUD skip indicator (counter or inspector panel) — revisit after the daemon logs give us labeled data
- Bundling skip/rag/tool into a single combined router classifier — depends on usage patterns we'll see post-launch
- Topic-shift detection that could reset session dedup on a context change (related but a separate feature)
- Utterance-relevance signals based on the corpus (e.g., "does this utterance mention any indexed entity") — a richer signal but requires touching the index path

**Outside this product's identity:**
- The pre-classifier never *takes action* in response to a skip decision. It does not retract previously-surfaced cards, notify the user, or change meeting state. Its only output is *don't run the pipeline*.
- The classifier does not judge whether the user "would want" context for an utterance. It judges only whether the utterance has substantive content. The product's confidence threshold and dedup gates make the rest of the call downstream.

---

## Dependencies / Assumptions

- The existing router infrastructure is the model: `apps/daemon/src/router/anthropic-classifier.ts` shows the retry shape, the cacheable prompt pattern, the parallel-with-retrieval execution path, and the Anthropic consent gate integration.
- The pre-classifier's Claude call uses the same `ANTHROPIC_API_KEY` and consent grant as the router and synthesizer — no separate key, no separate consent.
- Anthropic prompt caching requires the cached prefix to be at least 4096 tokens at Haiku tier. The pre-classifier's prompt will need ~40+ worked examples to hit that floor, the same way the router prompt did.
- The fragment-handling decision in D4 depends on the windowText already concatenating recent finals — if the embed input were changed back to single-utterance-only, the fragment recovery would need a different mechanism.
- The skip telemetry assumes the daemon is producing structured logs the user can grep; this is already the case for `voyage.usage`, `synthesis.*`, `classifier.*`, and `skill.*` events.

---

## Success Criteria

Measured during dogfood after shipping:

1. In a typical 30-minute meeting, the HUD surfaces roughly 5–10 cards rather than today's pattern of many noisy cards. Manual review of the meeting transcript should show that the skipped utterances are mostly correct skips.
2. The number of `synthesis.skipped reason=all-already-surfaced` events caused by noise utterances drops materially. (This is the proxy for "Claude was about to fire on filler" because the pipeline currently runs all the way to the dedup gate before bailing.)
3. Voyage `providerCalls` per meeting drops in proportion to the skip rate.
4. **No regression** in the rate of legitimate surfaces. If real questions start being skipped, the filter is too aggressive and the bar from D1 was wrong.
5. The daemon log skip lines are readable enough that the user can spot-check filter quality after a meeting without re-instrumenting the pipeline.

---

## Open Questions

These are intentionally left for planning:

- Exact heuristic regex set and length thresholds
- LLM confidence threshold for `skip` (calibration during dogfood)
- LLM prompt content and worked-example set
- Where exactly the abort-embed signal fires in the parallel `Promise.race` between classifier and embed
- Whether the heuristic patterns are configurable / per-locale (out-of-scope for v1 but worth noting)
