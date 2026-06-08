---
date: 2026-06-08
status: completed
type: fix
---

# fix: Router anaphora context — feed the intent classifier recent finals

## Summary

The bot-worker intent/router classifier (`packages/engine/src/router/anthropic-classifier.ts`) decides skill-vs-RAG per utterance, but its only conversational context is the **rolling summary** (`current_topic` + `open_questions`), which **lags** the live transcript. Anaphoric follow-up tool questions therefore misroute to RAG: the classifier can't resolve a pronoun ("these issues") to the established entity (github) because the summary hasn't caught up. Fix it by also feeding the classifier the **recent finals** (the immediate anaphora antecedent) — already built in the core as `input.recentContext` and already passed to the synthesizer and the relevance gate, just not to the router.

Diagnosed via the transcript-replay harness (replaying meeting `6675501a`): utterance [6] "how many of **these** issues are there" — one turn after [5] "are there any open github issues" correctly routed to `github_count` — returned `intent: rag` and refused, because at [6] the summary still said *"checking whether the transcript capture is functioning properly"* (the stale [1]–[4] topic).

---

## Problem Frame

The core builds two kinds of conversational context per utterance:
- `lastSummary` — the rolling summary's `current_topic` / `open_questions`, refreshed on a cadence (lags by seconds-to-tens-of-seconds).
- `recentContext` — the effective window of recent finals (post-voiding), the immediate prior turns.

The **synthesizer** and the **relevance gate** receive `recentContext`. The **router classifier** does **not** — `core.ts` builds the router classifier's `context` from `input.lastSummary` only (the `routerEligible` block). So when a follow-up question's referent is one or two turns back (not yet in the summary), the classifier classifies it in isolation and falls back to RAG.

The classifier prompt already anticipates this — it instructs: *"A short utterance that looks open-ended in isolation may be a structured query about the established topic in context"* (`packages/engine/src/router/prompt.ts`). It just needs the right context delivered.

**Who is affected:** every meeting attendee whose follow-up tool questions ("how many of those", "what about the open ones", "and the bugs?") currently misroute to RAG and either refuse or answer weakly. The replay harness is the validation surface.

---

## Requirements

- **R1 — Recent-finals context for the router.** The router classifier receives the recent finals (the immediate prior turns) in addition to the rolling summary, so an anaphoric follow-up can be resolved against the established topic/entity.
- **R2 — Anaphoric tool follow-ups route to the skill.** Given a tool-shaped follow-up whose antecedent (e.g. "github issues") is in the recent finals, the classifier returns the tool intent, not RAG. (Concretely: replaying `6675501a`, [6] "how many of these issues are there" → `github_count`.)
- **R3 — No over-routing regression.** Genuinely open-ended / RAG questions with unrelated recent finals must still route to RAG. Feeding finals must not make the classifier eagerly route non-tool questions to tools.
- **R4 — Prod behavior is the only thing changing, deliberately and narrowly.** This changes router classification behavior on purpose; everything else (cooldown, dedup, relevance gate, synthesis) is untouched.
- **R5 — Deterministic regression coverage.** Pin the routing decision with a test at the router boundary (prompt render + classifier context), not only a golden question — per the eval-regression-coverage learning, the eval replay skips the classifier path so a golden question alone won't catch a recurrence.

---

## Key Technical Decisions

- **KTD1 — Recent finals ALONGSIDE the rolling summary, not instead of it.** The summary carries longer-range topic memory; the finals carry the immediate antecedent. Both are useful and complementary — drop neither. (Resolves the origin's "in addition to / instead of" fork.)
- **KTD2 — Feed the same `recentContext` the synthesizer/relevance gate already get.** Reuse the core's existing `input.recentContext` (the effective window, post-voiding) rather than inventing a new trimmed window. Consistency across the three LLM calls, and it's the window already tuned for context. If over-routing appears in validation, the render can cap to the last N turns (deferred — see Open Questions); start with the existing window.
- **KTD3 — Render finals as a distinct "Recent turns" block in the classifier user message.** Add to `buildClassifierUserMessage`'s existing "Meeting context so far:" preamble, kept separate from `current_topic` / `open_questions` so the model (and log readers) can tell summary-memory from verbatim-recent-turns. Mirror the relevance classifier's context-rendering shape.
- **KTD4 — Characterization-first on the prod-behavior change.** The router's existing tests are the baseline; add the new context path without changing the no-context / summary-only renders (back-compat: an utterance with no finals renders exactly as today).
- **KTD5 — Over-routing guard is a first-class test, not an afterthought.** R3 gets explicit negative coverage: a non-tool question with unrelated finds must still classify RAG. This is the inverse failure the change risks.

---

## Implementation Units

### U1. Add recent-finals to the classifier context shape + render

- **Goal:** Extend the router classifier's context contract to carry recent finals and render them in the user message, without changing the existing summary-only / no-context output.
- **Requirements:** R1, R3, R4; KTD1, KTD3, KTD4.
- **Dependencies:** none.
- **Files:**
  - `packages/engine/src/router/contract.ts` (modify — add `recent_finals?: readonly string[]` to the `ClassifyInput` context shape / `ClassifierUserContext`)
  - `packages/engine/src/router/prompt.ts` (modify — add `recent_finals` to `ClassifierUserContext`; render a "Recent turns" block in `buildClassifierUserMessage`)
  - `packages/engine/test/router/prompt.test.ts` (modify — render coverage)
- **Approach:** Add an optional `recent_finals?: readonly string[]` field to the classifier context interface(s). In `buildClassifierUserMessage`, when `recent_finals` is non-empty, append a labeled block (e.g. "Recent turns (most recent last):" with each final on its own line) inside the existing "Meeting context so far:" preamble, after `current_topic` / `open_questions`. The `hasContext` guard must now also fire when only `recent_finals` is present (so finals alone still produce the context preamble). When all three are empty/absent, return the bare utterance exactly as today (back-compat).
- **Execution note:** Characterization-first — first assert the existing renders (no context; summary-only) are byte-identical, then add the finals block.
- **Patterns to follow:** the relevance classifier's `buildRelevanceUserMessage` context rendering (`packages/engine/src/relevance/prompt.ts`); the existing `buildClassifierUserMessage` block structure.
- **Test scenarios:**
  - No context (no summary, no finals) → bare utterance, byte-identical to today.
  - Summary-only (no finals) → existing "Meeting context so far:" render, byte-identical to today.
  - Finals-only (no summary) → the preamble fires with a "Recent turns" block and the utterance; no `current_topic` / `open_questions` lines.
  - Summary + finals → both blocks present, finals labeled distinctly from summary.
  - Empty `recent_finals: []` is treated as absent (no block, no preamble unless summary present).
  - The finals block preserves order (most-recent-last) and includes the verbatim text.
- **Verification:** `prompt.test.ts` passes; the no-context and summary-only renders are unchanged (diff shows only additive finals rendering).

### U2. Wire `recentContext` into the router classifier call

- **Goal:** Pass the core's `input.recentContext` (recent finals) into the router classifier's context, alongside the existing summary fields.
- **Requirements:** R1, R2, R4; KTD1, KTD2.
- **Dependencies:** U1.
- **Files:**
  - `apps/bot-worker/src/pipeline/core.ts` (modify — the `routerEligible` block that builds `deps.routerClassifier.classify({ utterance, registry, context })`)
  - `apps/bot-worker/test/pipeline/core.test.ts` (modify — assert the classifier receives the recent finals in its context)
- **Approach:** In the router-eligible block, when building the classifier `context`, include `recent_finals: input.recentContext` (the effective window already on `PipelineInput`). Keep `current_topic` / `open_questions` from `input.lastSummary` exactly as today. The `hasContext` decision should fire when EITHER the summary has content OR `recentContext` is non-empty (so a follow-up early in a meeting — before the summary populates — still gets finals context). Rebuild `packages/engine` (built dist) before bot-worker typecheck/tests.
- **Patterns to follow:** the existing relevance-gate context build in the same file (`relevanceContextFrom`), which already threads `recentContext`-derived context; the current router `classify(...)` call site.
- **Test scenarios:**
  - A tool-shaped utterance with non-empty `recentContext` → the classifier is called with `context.recent_finals` equal to the recent finals (capture the classify mock's args).
  - Summary present + finals present → both flow into the context.
  - No summary + finals present → the classifier still receives context (recent_finals), i.e. `hasContext` fires on finals alone.
  - No summary + no finals → no context passed (legacy isolated-utterance path), unchanged.
  - Router not eligible (not tool-shaped / no registry) → no classify call (unchanged).
- **Verification:** `core.test.ts` passes; a mocked classifier capturing its input shows the recent finals threaded; the no-context path is unchanged.

### U3. Deterministic router-boundary regression + over-routing guard

- **Goal:** Pin the new routing behavior with deterministic tests at the classifier boundary — both the positive (anaphoric follow-up → tool) and the negative (open-ended question with unrelated finals → RAG) — so neither failure can silently recur.
- **Requirements:** R2, R3, R5; KTD5.
- **Dependencies:** U1, U2.
- **Files:**
  - `packages/engine/test/router/anthropic-classifier.test.ts` (modify/create — boundary test using a stubbed Anthropic response, asserting the request body the classifier SENDS carries the finals context; the live LLM decision itself is non-deterministic and not asserted here)
  - `packages/engine/test/router/prompt.test.ts` (covered in U1 for the render; this unit adds the request-shape assertion)
- **Approach:** The LLM's actual tool-vs-rag choice is non-deterministic, so the deterministic boundary is the **request the classifier builds**: assert that given a context with `recent_finals` containing the github antecedent, the outbound user message includes the recent-turns block and the antecedent text (so the model is given what it needs to resolve the anaphora). Mirror the existing classifier test harness (stub `fetch` / the Anthropic transport). The end-to-end "does the model actually route to github_count" is validated at runtime via the replay re-run (see Verification / Validation), not pinned in a unit test.
- **Patterns to follow:** the existing `anthropic-classifier.test.ts` transport-stub pattern; the prompt render tests from U1.
- **Test scenarios:**
  - Covers R2. A tool-shaped follow-up + finals containing "are there any open github issues" → the built request's user message contains the recent-turns block with that antecedent.
  - Covers R3. A non-tool open-ended utterance + unrelated finals → the request still carries finals, but the test documents (and the validation step confirms) that the prompt's RAG-preference guidance is intact; no assertion forces a tool route.
  - Back-compat: no finals → request body has no recent-turns block.
- **Verification:** the engine router test suite passes; the request-shape assertions hold.

---

## Validation (runtime — not a unit test)

- **Replay re-run of `6675501a`** through the debug-parity harness (already shipped) at real cadence (speed 1, max-gap ~25s):
  - [6] "how many of these issues are there" → `SKILL github_count` (was RAG/refusal). **Primary success signal (R2).**
  - [1]–[4] (transcript-working thread) and [11]/[12] still route to RAG (R3 — no over-routing).
  - The github count questions still dedup as before (this change must not perturb the cooldown/dedup behavior fixed earlier).
- LLM is temperature 0, so the routing decision is stable enough to validate by replay; re-run once if a borderline case flickers.

---

## Scope Boundaries

### In scope
- The router classifier's conversational context (engine contract + render) and the core wiring that feeds it recent finals.
- Deterministic boundary tests + the replay validation.

### Deferred to Follow-Up Work
- Capping the finals window for the classifier (last N turns) if validation shows over-routing — start with the existing `recentContext` window.
- Extending the same recent-finals context to the relevance gate if it shows the same lag (it already gets `recentContext`-derived context, so likely unnecessary).
- A corpus-eval golden entry for anaphoric routing (the eval replay skips the classifier path; a router-boundary unit test is the deterministic anchor instead).

### Outside this product's identity
- Changing the cooldown / dedup / relevance gates or the `github_count` skill internals.
- The debug-parity harness (already shipped on `fix/github-skill-misroute`).

---

## Risks & Mitigations

- **Over-routing (the inverse failure):** feeding finals could make the classifier route genuine RAG questions to tools. Mitigation: KTD5 negative test + the replay R3 check ([1]–[4] stay RAG); the prompt's existing "prefer RAG when ambiguous" guidance is unchanged; the finals window can be capped (deferred) if needed.
- **Token / cache cost:** the finals add to the classifier prompt. Mitigation: `recentContext` is already bounded (the effective window); the classifier prompt has headroom under the cache-min proxy. Confirm the render stays within the cacheable-prefix assumptions noted in `prompt.ts`.
- **Built-dist drift:** engine changes need a rebuild before bot-worker tests. Mitigation: rebuild `packages/engine` in U2 before running core tests (called out in the unit).
- **Non-determinism masking a regression:** the LLM choice isn't pinned in unit tests. Mitigation: the deterministic anchor is the request shape (U3); the behavior is validated by replay; temperature 0 keeps it stable.

---

## Acceptance / Success Criteria

- Replaying `6675501a`: [6] routes to `github_count` (R2); [1]–[4]/[11] stay RAG (R3).
- The engine router suite + bot-worker core test pass; the no-context and summary-only classifier renders are byte-identical to before (R4).
- A deterministic router-boundary test fails if the finals context stops being delivered (R5).

---

## Notes for Implementation

- `engine` is consumed as built dist — `pnpm --filter @risezome/engine build` after editing `packages/engine/src/router/*` before bot-worker typecheck/tests.
- Prior art to mirror: `packages/engine/src/relevance/{contract,prompt}.ts` + `relevanceContextFrom` in `core.ts` (the relevance gate already threads recent context).
- Memory: `github-skill-misroute-root-causes` (the broader routing diagnosis) and `eval-regression-coverage` (pin at the deterministic boundary, not a golden question).

---

## Open Questions (deferred to implementation)

- **OQ1 — Finals window size for the classifier.** Start with the full `recentContext` (effective window). If the replay shows over-routing, cap to the last N (e.g. 2–3) turns. Resolve against the validation result, not up front.
- **OQ2 — Exact label / format of the recent-turns block.** "Recent turns (most recent last):" vs a numbered list — resolve in U1 against how the relevance classifier renders its context and what reads cleanly in the prompt.
