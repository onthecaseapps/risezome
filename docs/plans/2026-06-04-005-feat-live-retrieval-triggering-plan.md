---
date: 2026-06-04
status: active
type: feat
origin: docs/brainstorms/2026-06-04-live-retrieval-triggering-requirements.md
---

# feat: Live Retrieval Triggering & Query Construction (two-lane policy)

## Summary

Replace the live meeting's single blind 10s retrieval cooldown with a **two-lane triggering policy**: a QUESTION lane that always fires retrieval + synthesis on a detected substantive question (bypassing the cooldown and the about-our-work relevance gate, letting the synthesizer ground-or-refuse), and an AMBIENT lane that keeps the cost-budgeted throttle for proactive non-question surfacing. Add a high abuse ceiling on question-lane volume, embedding-based near-duplicate question suppression within a meeting, and a question-anchored retrieval query (the question utterance + a minimal context slice) replacing the blind 8-utterance concatenation. Extend the corpus eval page (`/debug/eval`) to display a per-question triggering verdict computed from the same classifier the live path uses.

---

## Problem Frame

The live pipeline (`apps/bot-worker/src/retrieval.ts`, `maybeRetrieveAndEmit`) gates retrieval to once per `COOLDOWN_MS = 10s`, keyed on `lastRetrievalAt`, and the gate fires on whichever utterance happens to cross the boundary — usually filler. A real question that lands inside the cooldown returns `{ skipped: 'cooldown' }` with no log, no synthesis, no card. This was root-caused from an incident ("what ai models do we use" produced nothing because a filler utterance triggered retrieval 3.9s earlier). The corpus, embeddings, reranker, and synthesizer were all verified healthy — the question simply never entered the pipeline.

A second weakness: the retrieval query is `recentFinals.join(' ')` (the last `WINDOW_UTTERANCES = 8` finals), so a clean question asked amid off-domain talk is embedded as the question plus seven unrelated lines, pulling retrieval toward the wrong domain.

Cost is the real constraint behind the cooldown — each fire is a Voyage embed + hybrid search + Claude synthesis — so the fix must bound cost (especially the expensive synthesis step) without dropping questions.

See origin: `docs/brainstorms/2026-06-04-live-retrieval-triggering-requirements.md`.

---

## Key Technical Decisions

**KTD1. The "substantive question" signal is net-new shared logic, not a read of existing classifiers.** Research confirmed `classifyRelevanceHeuristic` returns `clearly_filler | clearly_substantive | ambiguous`, where `clearly_substantive` fuses genuine questions with imperatives, filename mentions, and long statements; the LLM judge's `RelevanceResult` is only `surface | skip` with no question signal; and a rhetorical "…right?" appended to substantive text reads as `clearly_substantive` (any `?` triggers it). So a new classifier — `classifySubstantiveQuestion` in `packages/engine/src/relevance/` — isolates a genuine answerable question (interrogative form + substantive content + not rhetorical-tag-only / not a bare imperative). It is heuristic/deterministic (cheap, no LLM call) so it is reused verbatim by both the live adapter and the eval (R15 faithfulness). (see origin: R3, R15)

**KTD2. The QUESTION lane bypasses the core relevance gate via a lane flag; the synthesizer is the relevance backstop.** A new `lane: 'question' | 'ambient'` field on `PipelineInput`. When `lane === 'question'`, `runPipeline` skips its relevance gate (both the heuristic filler check and the about-our-work judge at the `routeToJudge` branch) and proceeds straight to embed → search → synthesis. The synthesizer's existing ground-or-refuse behavior is the only relevance filter for questions — a worst case of a cheap refusal, never a dropped answerable question. AMBIENT-lane fires keep today's gate behavior unchanged. (see origin: R1, R2, R4)

**KTD3. Lane routing and the abuse ceiling live in the adapter (`maybeRetrieveAndEmit`), not the core.** The cooldown is an adapter concern today and the lanes are too. QUESTION-lane fires bypass `COOLDOWN_MS` but are bounded by a high ceiling (per-minute soft cap + per-meeting cap), set well above normal conversational question rates. Over-ceiling, a question is throttled by falling back to the ambient cooldown (best-effort), not hard-dropped. Defaults (env-overridable, mirroring the existing `RISEZOME_*` constants): `RISEZOME_QUESTION_MAX_PER_MIN = 6`, `RISEZOME_QUESTION_MAX_PER_MEETING = 60`. AMBIENT keeps `COOLDOWN_MS = 10s`. (see origin: R5, R6, R7, R8)

**KTD4. Near-duplicate suppression is embedding-based, meeting-scoped, recency-bounded.** When a QUESTION-lane fire produces a grounded answer, record the question's embedding + timestamp in the per-meeting runtime. Before firing a new question, embed it and compare against recorded answered questions via `cosineDistance` (existing helper, `packages/engine/src/gaps/merge.ts`); suppress if within `RISEZOME_QUESTION_DUP_DISTANCE` (default `0.15`, tighter than the gap-merge `0.22` — questions must be genuinely the same to suppress) and within a recency window (`RISEZOME_QUESTION_DUP_WINDOW_MS`, default 5 min). A genuinely new question always fires. This adds one Voyage embed per question for the dedup check; acceptable because questions are infrequent (and the embed is the cheap step, not synthesis). (see origin: R9)

**KTD5. Question-anchored query = the question utterance (primary) + a minimal context slice; ambient keeps the rolling window.** For QUESTION-lane fires, `queryText` is built from `utteranceText` (the question, already available verbatim) plus a bounded slice for fragment/pronoun resolution — the rolling summary's `current_topic` and at most the 1–2 immediately-preceding finals — joined so the question dominates the embedding. AMBIENT-lane `queryText` keeps `recentFinals.join(' ')`. The context slice is intentionally small and bounded so off-domain talk can't dilute the question. (see origin: R10, R11, R12)

**KTD6. The eval shows a per-question triggering verdict computed from the shared classifier; stateful dedup/ceiling are not modeled as a sequence.** `evaluateQuestion` calls `classifySubstantiveQuestion` on the golden question and reports a `triggeringVerdict` (`lane`, `wouldFire`, and the question/filler reason) on `EvalQuestionView`. Dedup and ceiling are per-meeting stateful and shown as not-applicable in single-question eval mode (the deferred "model a sequence" option is out of scope — per-question classification is sufficient for the lane/question verdict). Same classifier as live ⇒ a golden pass implies live fires. (see origin: R14, R15, R16)

**KTD7. Shared by both entry points; no new persisted state, no encryption-boundary change.** The new `RetrievalRuntime` fields (answered-question embeddings + timestamps, question-fire timestamps) are in-memory per-meeting state, owned by the runtime struct in `apps/bot-worker/src/index.ts` (Recall/prod) and `apps/bot-worker/src/debug/local-capture.ts` (local dogfood) — both call `maybeRetrieveAndEmit` identically, so both inherit the behavior (R13). No DB columns are added. Synthesis output keeps its KMS encrypt-on-`done` contract; the eval verdict reads classification only and adds no plaintext synthesis column (see `docs/solutions/2026-06-03-content-encryption-at-rest.md`). Triggering signals read in-memory live utterance text, not stored encrypted transcript rows.

---

## High-Level Technical Design

Per-final-utterance decision flow in `maybeRetrieveAndEmit` (replacing the single cooldown gate):

```
final utterance u
  │
  ├─ push u → recentFinals (unchanged)
  │
  ├─ classifySubstantiveQuestion(u)?
  │
  ├── YES → QUESTION lane
  │     ├─ embed(u); near-dup of a recently-answered question?  ── yes ─▶ suppress (skip)
  │     ├─ over abuse ceiling (per-min / per-meeting)?           ── yes ─▶ fall back to ambient cooldown
  │     └─ fire: PipelineInput{ lane:'question', queryText = u + minimal context slice }
  │              → runPipeline SKIPS relevance gate → embed/search/synthesis (ground-or-refuse)
  │              → on grounded answer: record question embedding + ts
  │
  └── NO  → AMBIENT lane
        ├─ cooldown / threshold gate (today's COOLDOWN_MS)        ── blocked ─▶ skip
        └─ fire: PipelineInput{ lane:'ambient', queryText = recentFinals.join(' ') }
                 → runPipeline runs the relevance gate as today
```

The eval (`evaluateQuestion`) shares `runPipeline` and the classifier, but not the adapter's cooldown/dedup/ceiling state — it reports the lane verdict from `classifySubstantiveQuestion` alongside the existing synthesis result.

---

## Implementation Units

### U1. Substantive-question classifier (engine)

- **Goal:** A cheap, deterministic classifier that isolates a genuine answerable question from filler, rhetorical-tag-only utterances, bare imperatives, and statements — the QUESTION-lane signal, shared by live and eval.
- **Requirements:** R1, R3, R15 (origin).
- **Dependencies:** none.
- **Files:**
  - `packages/engine/src/relevance/substantive-question.ts` (create)
  - `packages/engine/src/relevance/index.ts` (modify — export)
  - `packages/engine/test/relevance/substantive-question.test.ts` (create)
- **Approach:** New `classifySubstantiveQuestion(text): { isQuestion: boolean; reason: string }` (or a small result type). Build on the existing `relevance/heuristic.ts` vocabulary (`FILLER_PATTERNS`, `SUBSTANTIVE_PATTERNS`, interrogative-word anchor) but narrow to questions: require an interrogative form (leading interrogative word OR a trailing `?` that is not merely a rhetorical tag) AND substantive content (not a filler phrase, not a bare imperative/filename-only match), AND exclude rhetorical-tag-only utterances ("right?", "you know?", "...makes sense, right?"). Keep it operating on the single utterance only (mirror the `classifyRelevanceHeuristic` caller contract). Pure function, no I/O.
- **Patterns to follow:** `packages/engine/src/relevance/heuristic.ts` (pattern arrays, length thresholds, the filler-first ordering); export style in `relevance/index.ts`.
- **Execution note:** Implement test-first — this is pure, high-value, edge-case-dense logic and the keystone both other surfaces depend on.
- **Test scenarios:**
  - Happy path: "what ai models do we use", "how does retrieval rank chunks?", "which embedding model?" → `isQuestion: true`.
  - Interrogative without `?`: "tell me how the cooldown works" → decide per design (imperative-question) and assert the chosen behavior explicitly.
  - Rhetorical exclusion (Covers AE3): "right?", "you know what I mean?", "that makes sense, right?" → `isQuestion: false`.
  - Filler: "um, so", "where were we" → `isQuestion: false`.
  - Bare statement / imperative-non-question: "the build is green", "open the file" → `isQuestion: false`.
  - Edge: empty string, whitespace, very long statement ending in `?`, a question embedded mid-utterance.
- **Verification:** All scenarios pass; the function is exported from `@risezome/engine/relevance` and importable from the bot-worker.

### U2. Two-lane triggering + abuse ceiling in the adapter

- **Goal:** Replace the single cooldown gate in `maybeRetrieveAndEmit` with lane routing: QUESTION lane bypasses the cooldown (bounded by a high abuse ceiling), AMBIENT lane keeps the cooldown/threshold. Add the `lane` flag to `PipelineInput` and the new runtime state.
- **Requirements:** R1, R5, R6, R7, R8, R13 (origin); resolves the original cooldown-drop incident (AE1).
- **Dependencies:** U1.
- **Files:**
  - `apps/bot-worker/src/retrieval.ts` (modify — lane routing, ceiling, runtime fields, `lane` on PipelineInput build)
  - `apps/bot-worker/src/pipeline/contract.ts` (modify — add `lane` to `PipelineInput`)
  - `apps/bot-worker/test/retrieval.test.ts` (create — first test for this adapter)
- **Approach:** After pushing to `recentFinals`, call `classifySubstantiveQuestion(utteranceText)`. QUESTION → skip the `COOLDOWN_MS` check; enforce the ceiling (KTD3) using new `RetrievalRuntime` fields (`questionFireTimestamps: number[]`); over-ceiling falls back to the ambient cooldown path. AMBIENT → today's `UTTERANCE_THRESHOLD` + `COOLDOWN_MS` gate unchanged. Set `lane` on the built `PipelineInput`. Add env-overridable constants (`RISEZOME_QUESTION_MAX_PER_MIN`, `RISEZOME_QUESTION_MAX_PER_MEETING`) alongside the existing ones. Update `newRetrievalRuntime()` to seed the new fields. Do NOT change the two call sites' shape (they pass `runtime.retrieval` as today) — the new state rides inside `RetrievalRuntime`, so both `index.ts` and `local-capture.ts` inherit it for free (R13).
- **Patterns to follow:** existing constant/env style in `retrieval.ts` (`COOLDOWN_MS`, `KEY_TERMS_BOOST_ENABLED`); `RetrievalRuntime` + `newRetrievalRuntime` shape.
- **Execution note:** Start with the failing regression test below before changing the gate.
- **Test scenarios:**
  - Covers AE1. A substantive question arrives `< COOLDOWN_MS` after a prior (ambient/filler) retrieval → it fires (NOT skipped as cooldown). This is the incident reproduction; assert it fails on the pre-change gate and passes after.
  - Ambient utterance within the cooldown → still skipped (ambient behavior preserved).
  - Ambient utterance after the cooldown → fires.
  - Covers AE5. A burst of questions beyond the per-minute / per-meeting ceiling → fires up to the ceiling, then throttles (falls back to cooldown); a normal 2–3-question exchange is unaffected.
  - The built `PipelineInput.lane` is `'question'` for a question, `'ambient'` otherwise.
  - Runtime state: `questionFireTimestamps` is pruned to the recency window; per-meeting count accumulates.
- **Verification:** `retrieval.test.ts` passes including the AE1 regression; a question is never dropped by the cooldown.

### U3. Question-anchored retrieval query

- **Goal:** For QUESTION-lane fires, build `queryText` from the question utterance + a minimal bounded context slice instead of the blind 8-utterance window; AMBIENT keeps the rolling window.
- **Requirements:** R10, R11, R12 (origin).
- **Dependencies:** U2.
- **Files:**
  - `apps/bot-worker/src/retrieval.ts` (modify — `queryText` construction fork)
  - `apps/bot-worker/test/retrieval.test.ts` (extend)
- **Approach:** In the query-build block, branch on lane. QUESTION: `queryText` = the question utterance as the primary signal, optionally prefixed/suffixed with a small slice — `lastSummary.current_topic` and at most the 1–2 immediately-preceding finals (`recentFinals.slice(-3, -1)`) — sized so the question dominates. AMBIENT: unchanged (`recentFinals.join(' ')` + existing keyTermsBoost behavior). Keep `utteranceText` (the gate/classifier input) as the single utterance regardless.
- **Patterns to follow:** the existing `queryText` / `recentContext` construction in `retrieval.ts:148-182`.
- **Test scenarios:**
  - Covers AE6. A question amid off-domain finals → `queryText` is dominated by the question utterance, not the surrounding window (assert the off-domain lines are absent or minimized).
  - A fragment follow-up ("and historically?") → the minimal context slice (current_topic + prior final) is included for resolution.
  - Ambient fire → `queryText` still equals the joined rolling window (unchanged).
- **Verification:** Question-lane `queryText` reflects the question; ambient unchanged.

### U4. Core gate bypass for the question lane

- **Goal:** `runPipeline` honors `PipelineInput.lane === 'question'` by skipping its relevance gate (heuristic filler check + about-our-work judge), going straight to retrieval + synthesis.
- **Requirements:** R2, R4 (origin).
- **Dependencies:** U2 (defines the `lane` field).
- **Files:**
  - `apps/bot-worker/src/pipeline/core.ts` (modify — gate short-circuit)
  - `apps/bot-worker/test/pipeline/core.test.ts` (extend)
- **Approach:** At the top of the gate block (`core.ts:155-232`), when `input.lane === 'question'`, skip both the `classifyRelevanceHeuristic` early-return and the `routeToJudge` / `relevanceClassifier` path, and proceed to embed/search/synthesis. Ambient (`lane === 'ambient'` or undefined for back-compat) runs the gate exactly as today. Do not alter the synthesizer's refusal handling — it remains the backstop.
- **Patterns to follow:** the existing gate structure and `skipped` return shapes in `core.ts`; `core.test.ts` fakes (`fakeEmbedder`, fake sink).
- **Test scenarios:**
  - `lane: 'question'` with an utterance the gate would normally skip (e.g., ambiguous / would-skip judge) → pipeline still runs embed/search/synthesis (no `relevance_skip`).
  - Covers AE2. `lane: 'question'`, retrieval yields off-topic sources → synthesizer refuses; no card surfaces (cheap refusal, not a gate drop).
  - `lane: 'ambient'` → gate behaves exactly as today (filler skip, judge skip paths unchanged).
  - Back-compat: `lane` undefined → treated as ambient.
- **Verification:** Question-lane inputs bypass the gate; ambient/legacy inputs are unchanged.

### U5. Near-duplicate question suppression

- **Goal:** Suppress a question semantically near one already answered this meeting; record answered-question embeddings on grounded answers.
- **Requirements:** R9 (origin).
- **Dependencies:** U2.
- **Files:**
  - `apps/bot-worker/src/retrieval.ts` (modify — dedup check before firing; record on grounded answer)
  - `apps/bot-worker/test/retrieval.test.ts` (extend)
- **Approach:** Before a QUESTION-lane fire, embed the question (`args.embedder.embed`) and compare against `RetrievalRuntime.answeredQuestions` (`{ embedding: number[]; at: number }[]`) via `cosineDistance` (from `@risezome/engine/gaps`); suppress when within `RISEZOME_QUESTION_DUP_DISTANCE` and the recency window. Record a question's embedding + timestamp when its fire yields a grounded (non-refusal) answer — wire the record-back through the fire path's completion signal. Convert `Float32Array` → `number[]` (`Array.from`) for `cosineDistance`. Prune entries past the recency window.
- **Patterns to follow:** `cosineDistance` + `GAP_MERGE_MAX_DISTANCE` precedent in `packages/engine/src/gaps/merge.ts`; embedder usage at `core.ts:310`.
- **Test scenarios:**
  - Covers AE4. The same question twice within the window → first fires, second suppressed.
  - A rephrasing that is genuinely a different question → fires (not suppressed).
  - A near-duplicate outside the recency window → fires again.
  - A refused question is NOT recorded as answered (so a later genuine re-ask can still fire).
  - Dedup compares against recorded embeddings using `cosineDistance` with the configured threshold.
- **Verification:** Duplicate questions are suppressed; new/rephrased questions fire; refusals don't poison the dedup history.

### U6. Eval triggering verdict (bot-worker)

- **Goal:** `evaluateQuestion` computes a per-question triggering verdict from the shared classifier and returns it on `EvalQuestionView`; golden set gains filler/rhetorical examples.
- **Requirements:** R14, R15, R16 (origin).
- **Dependencies:** U1.
- **Files:**
  - `apps/bot-worker/src/corpus-eval.ts` (modify — `triggeringVerdict` on `EvalQuestionView`, populate in `evaluateQuestion`)
  - `apps/bot-worker/eval/golden-questions.jsonl` (modify — add filler/rhetorical "would not fire" examples)
  - `apps/bot-worker/test/corpus-eval-trigger.test.ts` (create) or extend an existing corpus-eval test
- **Approach:** Add `triggeringVerdict: { lane: 'question' | 'ambient'; wouldFire: boolean; isQuestion: boolean; reason: string }` to `EvalQuestionView` (near `gateSuppressed`/`trace`). In `evaluateQuestion`, call `classifySubstantiveQuestion(question.q)` and populate it; dedup/ceiling are not modeled (single-question mode) — note them as n/a in the shape if surfaced. Add a few golden questions whose verdict is "would not fire" (rhetorical/filler) so the eval validates both directions (R16). No change needed to the `/run` route handler or the portal proxy (the field passes through verbatim), but confirm `cleanQuestion` isn't stripping anything relevant (it sanitizes the *input* question, not the response).
- **Patterns to follow:** `EvalQuestionView` assembly in `corpus-eval.ts:292-353`; golden-set format + `validateGoldenSet`.
- **Test scenarios:**
  - Covers AE7. A real golden question → `triggeringVerdict.lane === 'question'`, `wouldFire === true`, alongside the existing synthesis result.
  - A filler/rhetorical golden example → `lane === 'ambient'` / `wouldFire === false`.
  - The verdict uses the SAME `classifySubstantiveQuestion` as live (import identity / behavior parity).
  - `validateGoldenSet` still passes with the new examples.
- **Verification:** `/run` responses carry `triggeringVerdict`; golden set covers both fire and no-fire.

### U7. Eval UI — render the triggering verdict (portal)

- **Goal:** The `/debug/eval` Run output shows the triggering verdict (badge + a small block) so the policy is visible and testable.
- **Requirements:** R14, R16 (origin).
- **Dependencies:** U6.
- **Files:**
  - `apps/portal/app/(authed)/debug/eval/_client.tsx` (modify — `QuestionView` field + render)
  - `apps/portal/test/eval-trigger-verdict.test.tsx` (create) — mirror existing `.tsx` component tests
- **Approach:** Add `triggeringVerdict` to the client `QuestionView` interface (it hand-mirrors `EvalQuestionView`). Render a verdict badge in the `QuestionCard` badge row (e.g., "QUESTION · fires" / "would not fire") and/or a short block at the top of `ViewBody` showing lane + isQuestion + reason. Optionally surface a "would-fire / would-not-fire" rollup in the aggregate header. The portal proxy passes the field through with no change.
- **Patterns to follow:** badge + `ViewBody` rendering in `_client.tsx` (`QuestionCard` ~line 263, `ViewBody` ~line 310); existing component tests `apps/portal/test/live-mic-trace.test.tsx`, `test/hud-card.test.tsx`.
- **Test scenarios:**
  - A Run result with `lane: 'question', wouldFire: true` → the verdict badge/block renders with the "fires" state.
  - A `wouldFire: false` result → renders the "would not fire" state.
  - Absent verdict (back-compat with an older response) → renders without crashing.
- **Verification:** Running a golden question on `/debug/eval` visibly shows its triggering verdict alongside synthesis + citations.

---

## Scope Boundaries

- Out: corpus coverage, embeddings, hybrid search, the reranker, and synthesizer prompt/quality — all verified healthy in the debug. This work changes *when* we fire and *what query* we build, not retrieval/synthesis internals.
- Out: an explicit wake-phrase / direct-address invocation model (rejected in brainstorm).
- Out: an LLM query-rewrite step for question normalization (deferred in brainstorm in favor of question-anchored-plus-context).
- Out: modeling a question *sequence* in the eval to exercise dedup/ceiling state (KTD6) — per-question classification only.
- In (UI): the `/debug/eval` triggering verdict only. The live meeting HUD is NOT changed in this scope.

### Deferred to Follow-Up Work

- Possibly minimizing the AMBIENT lane toward question-answering-only (the lower-value, noise-prone path) — kept budgeted for now (origin "Possible future direction").
- Removing the duplicate `keyTermsBoost` implementation across `retrieval.ts` and `core.ts` — untouched here; not in scope.
- A `/ce-compound` learning capturing the two-lane split + gate-bypass rationale after this lands (no `docs/solutions/` entry exists for this subsystem).

---

## System-Wide Impact

- Both bot-worker entry points (`index.ts` Recall/prod, `debug/local-capture.ts` local dogfood) inherit the behavior through the shared `RetrievalRuntime` + `maybeRetrieveAndEmit` — no per-caller change (R13).
- No DB schema or migration. New state is in-memory per-meeting only.
- Encryption boundary unchanged: synthesis stays KMS-encrypted on `done`; the eval verdict adds no plaintext synthesis surface (see `docs/solutions/2026-06-03-content-encryption-at-rest.md`).
- Cost profile shifts: questions fire more readily (uncapped in normal use) while ambient stays throttled; the per-question dedup adds one embed per question. Net cost is bounded by the abuse ceiling.

---

## Risks & Mitigations

- **Question detection precision (KTD1).** Too narrow → real questions miss the lane (regression toward the original bug); too broad → over-fire cost. Mitigation: heuristic is test-dense (U1), the abuse ceiling caps the downside, and the synthesizer refuses off-topic questions cheaply. The eval verdict (U6/U7) makes precision observable on the golden set.
- **Dedup false-positives.** Too loose a threshold suppresses genuine follow-ups. Mitigation: tighter default distance (`0.15`) than gap-merge, recency-bounded, and refusals are never recorded.
- **Lane-flag back-compat.** `PipelineInput.lane` is new; legacy/eval callers without it must behave as ambient. Mitigation: treat undefined as ambient (U4 test).
- **Ceiling defaults.** Wrong numbers either throttle real use or under-protect. Mitigation: env-overridable; defaults set well above observed conversational question rates.

---

## Acceptance Examples (from origin)

Carried from the requirements doc; each maps to a test scenario above: AE1 (question within cooldown fires → U2), AE2 (off-topic question → cheap refusal → U4), AE3 (rhetorical not a question → U1), AE4 (duplicate suppressed → U5), AE5 (burst hits ceiling → U2), AE6 (question-anchored query → U3), AE7 (eval verdict visible → U6/U7).

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-04-live-retrieval-triggering-requirements.md`.
- `apps/bot-worker/src/retrieval.ts` — `maybeRetrieveAndEmit`, constants, `RetrievalRuntime`, `PipelineInput` build, the cooldown gate (the silent-drop site).
- `apps/bot-worker/src/pipeline/core.ts` — relevance gate (`classifyRelevanceHeuristic` heuristic step, `routeToJudge` branch, `relevanceClassifier.classify`), embed/search, synthesizer invocation.
- `packages/engine/src/relevance/` — `heuristic.ts` (`RelevanceHeuristicResult`), `contract.ts` (`RelevanceResult` is `surface|skip` only — no question signal), `index.ts` exports. Confirms KTD1: the question signal must be new.
- `packages/engine/src/gaps/merge.ts` — `cosineDistance` + `GAP_MERGE_MAX_DISTANCE` precedent (reused for KTD4).
- `packages/engine/src/summarize/contract.ts` — `MeetingSummary` (`summary`, `current_topic`, `open_questions`, `key_terms`) for the context slice.
- `apps/bot-worker/src/corpus-eval.ts` (`evaluateQuestion`, `EvalQuestionView`), `apps/bot-worker/src/debug/eval-routes.ts` (`/run`, `cleanQuestion`), `apps/portal/app/api/debug/eval/route.ts` (passthrough proxy), `apps/portal/app/(authed)/debug/eval/_client.tsx` (`QuestionView`, `QuestionCard`, `ViewBody`).
- Ownership: `apps/bot-worker/src/index.ts` (`MeetingState.retrieval`) and `apps/bot-worker/src/debug/local-capture.ts` — both call `maybeRetrieveAndEmit` identically (R13).
- Tests to mirror: `apps/bot-worker/test/pipeline/core.test.ts`, `apps/bot-worker/test/debug/eval-routes.test.ts`; no `retrieval.test.ts` exists yet (create for U2). Golden set: `apps/bot-worker/eval/golden-questions.jsonl` + `validateGoldenSet`.
- Learning: `docs/solutions/2026-06-03-content-encryption-at-rest.md` (synthesis KMS encrypt-on-done; corpus plaintext-at-app-layer by design; use in-memory live text for triggering). MEMORY rule: pair retrieval/synthesis behavior changes with a golden question or unit test.
