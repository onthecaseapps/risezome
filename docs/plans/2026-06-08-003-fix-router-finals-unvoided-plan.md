---
date: 2026-06-08
status: active
type: fix
---

# fix: Router anaphora — give the classifier an UN-VOIDED finals window

## Summary

The prior fix (`docs/plans/2026-06-08-002-fix-router-anaphora-context-plan.md`) wired
`input.recentContext` into the router/intent classifier so anaphoric tool
follow-ups ("how many of **these** issues") could resolve the pronoun to the
established entity (github) and route to the skill. A real-cadence replay of
meeting `6675501a` proves it **did not fix [6]** — and the enhanced copy-summary
shows exactly why.

`recentContext` is built from the **answer-voided** effective window
(`effectiveWindow(recentFinals, consumedFinals)`, `apps/bot-worker/src/retrieval.ts`).
Mechanism A (answer-dedup) voids the **entire window that fed a grounded answer**
into `consumedFinals` the moment that turn grounds. So the utterance immediately
after any grounded answer sees a finals window emptied of the just-answered turn —
which is precisely the most common anaphora case ("answer X" → "how many of those
X"). At [6] the classifier's `recent_finals` was just the stale rolling summary;
the antecedent [5] "are there any open github issues" had been voided. Pronoun
unresolvable → `intent: rag`.

**Fix:** give the router classifier its **own un-voided finals window** (the raw
`recentFinals` minus the current utterance). Voiding is correct for the
synthesizer / query-build / dedup (its job: stop answered transcript from
re-seeding retrieval and re-answering) but wrong for intent classification, whose
job is the opposite — resolve a pronoun against what was just discussed.

---

## Problem Frame

Two consumers, opposite needs, currently share one window:

| Consumer | Needs | Window today |
|----------|-------|--------------|
| Synthesizer / query-build / dedup | answered spans **voided** (don't re-answer, don't re-seed retrieval) | `effectiveWindow` (voided) ✓ correct |
| Router intent classifier (anaphora) | answered turns **retained** (resolve "these issues" → the github turn just answered) | `effectiveWindow` (voided) ✗ wrong |

Evidence (replay `6675501a`, real cadence, enhanced copy-summary):
- **[5]** "are there any open github issues" → `SKILL github_list` (grounded). Its
  `onGroundedAnswer` voids the whole effective window (incl. [5]) into `consumedFinals`.
- **[6]** "how many of these issues are there" → `RAG — router chose rag (not_tool_intent)`;
  `prior context (1): · <stale rolling summary>` — the antecedent [5] is gone.

Mechanism confirmed in code: `retrieval.ts:266` (`effective = effectiveWindow(...)`),
`retrieval.ts:332` (recentContext finals = `effective.slice(0,-1)`),
`retrieval.ts:443` (`addConsumedFinals` on grounded), and
`apps/bot-worker/src/pipeline/answer-dedup.ts:22` (`effectiveWindow` removes
`consumedFinals` text).

## Scope Boundaries (non-goals)

- **Do not change Mechanism A voiding** — `recentContext`, query-build, ambient
  join, dedup all keep the voided window unchanged. This is purely an *additional*
  un-voided list for the classifier.
- **Do not change the engine classifier** — `packages/engine/src/router/*` already
  accepts `recent_finals` (shipped `8d93b8f`). No engine src change ⇒ no rebuild.
- Out of scope: cooldown/dedup gate values, the `github_count`/`github_list` skill
  internals, the debug-parity harness, whether [5] should route to count vs list.

## Requirements

- R1: `PipelineInput` carries a distinct `routerRecentFinals?: readonly string[]` —
  un-voided recent finals (answered turns retained), classifier-facing only.
- R2: `core.ts` feeds the classifier `recent_finals` from `routerRecentFinals` when
  present, falling back to `recentContext` for back-compat (eval/legacy/tests).
  `recentContext` keeps feeding the synthesizer / `priorContext` trace unchanged.
- R3: `retrieval.ts` populates `routerRecentFinals` from the raw
  `runtime.recentFinals.slice(0, -1)` (un-voided, excludes the current utterance),
  passed only when non-empty.
- R4: prod retrieval behavior otherwise unchanged — `retrieval.test.ts` stays green.

---

## Implementation Units

### U1 — contract + core: distinct un-voided classifier window

**Goal:** add `routerRecentFinals` to `PipelineInput`; prefer it for the
classifier's `recent_finals`; leave `recentContext` (synthesizer) untouched.

**Files:**
- Modify: `apps/bot-worker/src/pipeline/contract.ts` (add the field + doc)
- Modify: `apps/bot-worker/src/pipeline/core.ts` (`routerEligible` block ~L261-285:
  `const recentFinals = input.routerRecentFinals ?? input.recentContext ?? []`)
- Test: `apps/bot-worker/test/pipeline/core.test.ts`

**Approach:** in the classifier-context block, source `recent_finals` from
`routerRecentFinals` first. `hasContext` already fires on finals alone. The
synthesizer's `priorContext: input.recentContext ?? []` (core.ts:131) is unchanged.

**Test scenarios (U1):**
- When `routerRecentFinals` is set AND `recentContext` is a *different* (voided)
  list, the captured classify request's `context.recent_finals` equals
  `routerRecentFinals` (NOT `recentContext`) — the un-voided antecedent reaches the
  classifier even though the synthesizer window voided it. (The motivating bug.)
- Back-compat: with only `recentContext` set (no `routerRecentFinals`), the
  classifier still receives `recentContext` as `recent_finals` (existing tests stay green).
- The synthesizer-facing `priorContext` in the emitted trace still equals
  `recentContext`, not `routerRecentFinals`.

**Execution note:** characterization-first — the existing three classifier-context
tests (core.test.ts ~L870-914) must stay green byte-for-byte (back-compat fallback).

**Verification:** `pnpm --filter @risezome/bot-worker exec vitest run test/pipeline/core.test.ts`; tsc; lint.

### U2 — retrieval: populate the un-voided window

**Goal:** pass the raw recent finals (un-voided) on `routerRecentFinals`.

**Files:**
- Modify: `apps/bot-worker/src/retrieval.ts` (after the `recentContext` build ~L326-334,
  add `const routerRecentFinals = args.runtime.recentFinals.slice(0, -1)` and spread
  it onto `input` when non-empty)
- Test: `apps/bot-worker/test/retrieval.test.ts`

**Approach:** `recentFinals` always has the current utterance pushed last
(`retrieval.ts:240`), so `.slice(0, -1)` is the prior finals, un-voided by
`consumedFinals`. Spread `...(routerRecentFinals.length > 0 ? { routerRecentFinals } : {})`.

**Test scenarios (U2):** companion to the existing Mechanism-A test
(`retrieval.test.ts:301`): after an answered final voids a span from
`recentContext`, the SAME next question's `routerRecentFinals` **retains** that
answered antecedent (un-voided). Assert `lastInput().recentContext` excludes it AND
`lastInput().routerRecentFinals` includes it — the two windows diverge exactly as
designed.

**Execution note:** characterization-first — `retrieval.test.ts` is the prod safety net.

**Verification:** `pnpm --filter @risezome/bot-worker exec vitest run test/retrieval.test.ts`; tsc; lint.

---

## Validation (runtime, post-implementation — user runs)

Re-replay meeting `6675501a` scoped (speed 1, max-gap 25000). Expect:
- **[6]** "how many of these issues are there" → routes to a github skill
  (`github_count`), not RAG. (LLM-dependent; the deterministic U1 test pins the
  *request shape* — the un-voided antecedent reaches the classifier.)
- **[1]–[4], [11]** stay RAG (they fail `isToolShaped`; the classifier never runs).
- No new over-answering — Mechanism A/B dedup unchanged.

## Risks

- **Over-routing:** low — the classifier only runs on `isToolShaped` utterances, so
  non-tool turns ([1]–[4]/[11]) never see the richer context. It only sharpens
  already-tool-shaped questions.
- **Stale antecedent:** `recentFinals` is capped at `WINDOW_UTTERANCES` (8), so the
  un-voided window is naturally bounded; no unbounded growth.
