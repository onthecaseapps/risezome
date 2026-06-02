---
title: "feat: Self-healing skills + router safety-net for messy-speech robustness"
status: completed
date: 2026-06-02
type: feat
origin: docs/brainstorms/2026-06-02-skills-rag-robustness-requirements.md
---

# feat: Self-healing skills + router safety-net for messy-speech robustness

## Summary

Skill answers (GitHub/Trello counts, lists) currently extract their arguments from raw meeting speech in one shot, with no recovery: a mis-extracted argument (the live failure: *"open **case** issues"* → `labels:["case"]` → a misleading `0`) is reported as authoritative fact. This plan makes skills **self-heal** — each validates its free-text arguments against its own domain, neutralizes bogus ones, re-runs the query, and returns a structured **recovery signal** with an honest caveat. A thin **router safety-net** reads that signal and decides *keep the repaired result + RAG* vs *drop to RAG-only*, and the synthesizer is taught never to state a suspect/repaired result as fact. The correct common path — where extraction was right — pays nothing: validation is deterministic, conditional, and (except one cached GitHub fetch) uses data already in hand.

Origin: `docs/brainstorms/2026-06-02-skills-rag-robustness-requirements.md`.

---

## Problem Frame

The router classifies a meeting utterance to a skill and extracts its args from Claude's `tool_use.input`. Anthropic validates those args against the JSON Schema (shape) but **not against domain facts** (a real label, a real member). The bot-worker then runs the handler, wraps the result via `formatAsSource` into `source[0]`, and feeds it to synthesis as authoritative. When a free-text arg is mis-extracted from messy speech, the skill silently filters on a value that doesn't exist and returns a confident `0` — worse than no answer, because the participant glances at the card and acts on it.

Today the pipeline already handles two skill outcomes: **success** (`toolSource` kept at `source[0]`) and **`SkillExecutionError`** (rate-limit/auth/404 → `toolSource = null` → RAG-only synthesis). The genuinely new state this plan introduces is the **middle case: a valid call that returns a misparsed result** — a `0` that is a misparse, not a genuine empty result (KD6). That state must be detected structurally and recovered, without slowing the common path.

---

## Requirements

Traceability to origin (`R*` requirements, `AE*` acceptance examples, `KD*` decisions carried from the brainstorm):

- **R1** — A mis-extracted argument must never yield a confidently-wrong answer **from a non-existent filter value**: bogus (non-existent) free-text args are neutralized, not silently filtered on. *Valid-but-wrong extraction — a real value that isn't the one meant ("bug" heard as "bot" where both labels exist) — is explicitly out of scope (see Scope Boundaries); membership validation cannot catch it.* (U2, U3)
- **R2** — Recovery is conditional and mostly deterministic. The **safe-enum-only** common path (`state`/`type` only, or `due` only) pays nothing. A **label-filtered** query pays at most one cached `/labels` fetch per connected repo; Trello validates free in-memory. No model cost on the common path. (U2, U3)
- **R3** — Skills expose a structured recovery/confidence signal on their result, so consumers don't infer suspicion from a bare `0`. (U1)
- **R4** — The synthesizer consumes that signal and never states a suspect/repaired result as hard fact. (U5)
- **R5** — A router safety-net handles residual suspect/unrepairable results with one cheap step — keep-with-caveat or fall back to RAG — firing only on misfires. (U4)
- **R6 / KD4** — On a suspect-but-repairable result, keep the repaired skill answer at `source[0]` **plus** RAG; only drop the skill when unrepairable. (U1 `formatAsSource`, U4)
- **R7 / KD6** — A genuine empty/zero result (valid args, truly nothing matched) is stated correctly as fact and is distinguishable from a misparse-zero. (U2, U3 — validation distinguishes "arg invalid" from "arg valid, no matches")
- **Eval convention (standing memory)** — A retrieval/synthesis-class fix lands regression coverage in the automated pipeline; the skill/classifier path is the replay harness's blind spot, so AE1–AE5 become deterministic unit tests at the validation boundary, plus a golden question for the "open case" class. (U2, U3, U6)

---

## Key Technical Decisions

- **KTD1 — Recovery is an additive, optional field on `SkillResult`, never a mutation of `summary`.** The synthesizer prompt is tuned against exact skill summary strings (byte-equality tested in `packages/engine/test/skills/contract.test.ts`). The repair note rides in a new `recovery` field surfaced deliberately by `formatAsSource`, leaving `summary`/`items` untouched. (see origin: KD3)
- **KTD2 — Self-healing lives inside the handler, not in a generic router/engine wrapper.** The live GitHub/Trello client + per-org resolver are closed over in each `build*Skill(liveCtx)` factory and are **not** present in `SkillContext`. Validation that needs the live domain (GitHub label list, Trello member set) can only run where the client and args are both in scope — the handler closure. This refines the brainstorm's two-layer framing: the "one-step recovery" is the handler's validate→neutralize→re-run; the router's job narrows to a keep-vs-drop decision off the signal. (see origin: KD1, KD2)
- **KTD3 — Heal at the shared filter/qualifier layer where possible; author resolution is per-handler.** Trello skills funnel free-text args through `filterCards`/`collectCards` (`apps/bot-worker/src/skills/trello/filter.ts`) — one seam heals the whole family. GitHub `labels` heal at/around `buildSearchQualifiers` (`apps/bot-worker/src/skills/github/search_count.ts`). **Caveat:** `buildSearchQualifiers` is a *pure* function with no `access`/token in scope, while `resolvePerson` needs an installation token — so GitHub `author` validation runs in the **handler** (where `access` exists), feeding cleaned qualifiers in, not inside the pure qualifier builder.
- **KTD4 — Risky args = free-text domain values; safe args = closed enums.** Validate `labels` + `author` (GitHub) and `member`, `label`, `list`, `board` (Trello). Do **not** validate `state`, `type` (GitHub) or `due` (Trello) — closed enums the schema already constrains. Note `github_count`'s schema is `type`/`state`/`labels`/`author` — it has **no** `assignee` arg; `assignee` healing applies only to the issue-number skills (`by_assignee_*`, `issue_assignees`) that actually expose it. (resolves origin open question "which args are risky")
- **KTD5 — "Suspect" is the structured signal's presence, not a bare `0`.** A result is suspect when a `recovery` field is present; `formatAsSource` mirrors that onto a `SynthesisSource.suspect` boolean. The signal's *state* is `recovery.status`: `'repaired'` (a bogus arg was neutralized and a still-scoped query re-ran → keep + caveat) or `'unresolved'` (unsalvageable → drop to RAG). `'unresolved'` covers both a bogus arg that can't be salvaged **and** a transient validation failure (e.g. the `/labels` fetch erroring) — both mean "can't trust this result, fall back". A `0` with **no** `recovery` field is a genuine zero, stated as fact. (resolves origin open question "suspect-result definition"; see origin: KD6)
- **KTD6 — GitHub label validation fetches `/labels` per connected repo (union semantics); Trello validates in-memory for free.** Trello's `fetchEnrichedCards` already materializes each board's real members/labels/lists, so validation is substring-membership over data in hand (KTD9). GitHub has no label source today, and `GithubAccess` spans multiple installations × multiple repos — `searchIssuesCount` unions *every* connected repo into one query, so a label is valid if it exists in **any** connected repo. Add a `GET /repos/{owner}/{repo}/labels` fetch per connected repo, memoized per (installation, repo) for the request; validity = membership in the *union* of label sets (so a label real in repo B isn't neutralized because repo A lacks it). `author` reuses the existing `resolvePerson` (which `github_count` currently skips). (resolves origin open question "cost of domain check")
- **KTD7 — Preserve the flash-fix invariant.** Recovery runs inside `runSynthesisAndBroadcast`, which was just fixed to buffer tokens and reveal grounded-or-nothing on `done`. The router net must make its keep-vs-drop decision **before** synthesis starts (it already does — `mergedSources` is assembled before `runSynthesisAndBroadcast` is called), so no `synthesisStart` is ever emitted for an answer that's later dropped. No new streaming path is introduced. (see Risks)
- **KTD8 — Neutralizing the *only* free-text filter routes to `'unresolved'`, not `'repaired'`.** When neutralizing a bogus arg removes the only scoping filter so the re-run is unscoped (whole-repo / whole-board), classify `'unresolved'` (drop to RAG) — a broad answer to a narrow question ("312 open issues" when they asked about a specific slice) is a *different* confidently-misleading result. This makes the worst case a **structural** fallback rather than trusting the synthesizer to hedge it (see KTD7, Risks). This is the operative half of the repaired-vs-unresolved threshold; partially-scoped re-runs (other filters survive) stay `'repaired'`, and finer tuning is the only part deferred.
- **KTD9 — Trello bogus-detection mirrors the filter's substring semantics.** `filterCards` matches `member`/`label`/`list`/`board` by case-insensitive *substring* (`matchesText`), not equality — spoken "Alice" validly matches a member named "Alice Smith". So the bogus-detection predicate is "**no** real domain value *contains* the arg as a case-insensitive substring", **not** exact-set membership; otherwise valid partial/first-name speech the current filter accepts would be wrongly neutralized.

---

## High-Level Technical Design

### Recovery decision flow

The new **suspect-success** state sits between today's success and `SkillExecutionError` outcomes. Everything left of the dashed line runs inside the skill handler; everything right runs in `retrieval.ts` orchestration.

```mermaid
flowchart TD
    A["classifier → intent: tool<br/>skillName + args"] --> B["skill.handler(args, ctx)"]
    B --> C{"risky free-text arg<br/>present?"}
    C -->|no, or only safe enums| D["run query as-is"]
    C -->|yes| E["validate arg vs domain<br/>(Trello: in-memory set;<br/>GitHub: cached labels / resolvePerson)"]
    E -->|all valid| D
    E -->|bogus arg| F["neutralize arg, re-run query<br/>without it"]
    F -->|other filters survive<br/>(still scoped)| G["SkillResult + recovery:<br/>status='repaired', note"]
    F -->|only filter removed → unscoped,<br/>or can't validate| H["SkillResult + recovery:<br/>status='unresolved', note"]
    D --> I["SkillResult (no recovery)"]
    B -.throws.-> X["SkillExecutionError<br/>(existing path)"]

    I --> R{"router safety-net<br/>reads recovery.status"}
    G --> R
    H --> R
    R -->|absent / clean| K["toolSource at [0] + RAG<br/>normal synthesis"]
    R -->|'repaired'| L["toolSource at [0] + RAG<br/>+ honest caveat in source text"]
    R -->|'unresolved'| M["drop toolSource → RAG-only"]
    X --> M
    K --> S["runSynthesisAndBroadcast<br/>(buffer → grounded-or-nothing on done)"]
    L --> S
    M --> S
```

### Recovery signal shape (directional — final names settled in U1)

```ts
// Additive optional field on SkillResult. Absent ⇒ clean common path (most questions).
recovery?: {
  status: 'repaired' | 'unresolved';
  neutralized?: readonly { arg: string; value: string }[]; // what was dropped
  note: string; // honest caveat surfaced to synthesis, e.g.
                 // "There's no 'case' label — showing all open issues."
};
```

`formatAsSource` surfaces `note` into the rank-0 tool source text (and sets a `suspect` flag on the returned `SynthesisSource`) when `status` is present; `summary`/`items` are unchanged. This is directional guidance, not a final signature.

---

## Implementation Units

### U1. Recovery signal on `SkillResult` + `formatAsSource` plumbing

**Goal:** Add the structured recovery/confidence channel the whole feature hangs off — an additive `recovery` field on `SkillResult`, surfaced through `formatAsSource` into the synthesis source, plus a `suspect` flag on `SynthesisSource` for the renderer to key on.

**Requirements:** R3, R6/KD4, KTD1.

**Dependencies:** none (foundation).

**Files:**
- `packages/engine/src/skills/contract.ts` — add optional `recovery` to `SkillResult`; extend `formatAsSource` to prepend `note` to the source `text` and set `suspect` when `recovery.status` is present.
- `packages/engine/src/synthesize/contract.ts` — add optional `readonly suspect?: boolean` to `SynthesisSource`.
- `packages/engine/src/skills/index.ts` — re-export any new types if needed.
- `packages/engine/test/skills/contract.test.ts` — tests (see scenarios).

**Approach:** `recovery` is fully optional and defaulted-absent, so all 13 existing handlers keep compiling and behaving identically (the common path emits no `recovery`). `formatAsSource` keeps `title`/`items` rendering byte-identical; it only injects a caveat line into `text` when `recovery` is present, and stamps `suspect: true` on the `SynthesisSource`. Do **not** route the signal through `raw` (it never reaches the prompt by contract).

**Patterns to follow:** mirror the existing optional-field handling in `formatAsSource` (`items` is already conditionally appended); keep the `Tool: name(args)` title format unchanged.

**Test scenarios** (`packages/engine/test/skills/contract.test.ts`):
- Happy path: a `SkillResult` with no `recovery` → `formatAsSource` output is byte-identical to today (regression guard for the tuned summary strings). Covers R7.
- `recovery.status='repaired'` with a `note` → source `text` contains the note as a distinct caveat line; `summary`/`items` text unchanged; returned source has `suspect: true`.
- `recovery.status='unresolved'` with a `note` → `suspect: true`; note present.
- `neutralized` array populated → does not leak into `text` body beyond the `note` (telemetry-shaped, not prose).
- Type-level: an existing handler return value (no `recovery`) still satisfies `SkillResult`.

---

### U2. GitHub skills self-heal (label + author validation)

**Goal:** Validate GitHub free-text args (`labels`, `author`) against the live repo domain, neutralize bogus values, re-run, and return the recovery signal — healing the Search-API skills, with `github_count` as the primary surface.

**Requirements:** R1, R2, R7/KD6, KTD3, KTD4, KTD6, KTD8.

**Dependencies:** U1.

**Files:**
- `apps/bot-worker/src/skills/github/search_count.ts` — the `github_count` **handler** gains label + author validation + recovery assembly (the pure `buildSearchQualifiers` stays pure; cleaned qualifiers are fed in from the handler, where `access`/token live — KTD3).
- `apps/bot-worker/src/skills/github/person.ts` — reuse `resolvePerson(client, token, personToken)` for `author`; the handler supplies the installation token it already resolves.
- `apps/bot-worker/src/skills/github/client.ts` / `live-helpers.ts` — add a `GET /repos/{owner}/{repo}/labels` fetch, memoized per (installation, repo) for the request, via the existing `getJson` surface; iterate the connected repos from `GithubAccess.installations[].repos` (the same set `searchIssuesCount` unions).
- `apps/bot-worker/src/skills/github/self-heal.ts` (new) — small helper: "given a value and a domain set (or union), return valid | neutralized + note". Shared with the other Search skills later.
- `apps/bot-worker/test/skills/github/search_count.test.ts` — tests (primary GitHub surface).

**Approach:** Validation fires only when a risky arg is present (R2 — safe-enum-only queries pay nothing). For `author`, the handler routes the spoken token through `resolvePerson` (already `GITHUB_LOGIN_RE`-gated, already used by `github_by_author`) — `github_count` passes the raw token straight into the qualifier today, the concrete gap. For `labels`, fetch each connected repo's real label set (memoized per (installation, repo)) and validate against their **union** (KTD6) — a label real in any connected repo is valid; a label in none is bogus, dropped, and the query re-runs with the surviving qualifiers. Classification per KTD8: if a scoping qualifier survives (e.g. `state:open` remains), `status='repaired'` + note; if neutralizing leaves the query fully **unscoped** (the bogus arg was the *only* filter → whole-repo count), `status='unresolved'` so the router drops to RAG rather than answer a misleadingly-broad number. A genuinely valid arg that matches nothing returns **no** `recovery` (R7). Note `github_count` exposes no `assignee` (its schema is `type`/`state`/`labels`/`author`); `assignee` healing is a follow-on for the `by_assignee_*` skills (KTD4).

**Patterns to follow:** `github_by_author`'s existing graceful "Couldn't find a GitHub user matching…" `detail` result (`search_by_author.ts`) is the template, generalized to `count` and to labels. Use `_live-ctx.ts` test helpers (`SKILL_CTX`, `liveCtx`, `jsonResponse`, fake `fetchImpl`).

**Test scenarios** (`apps/bot-worker/test/skills/github/search_count.test.ts`):
- Covers AE1. `state:open` + `labels:["case"]`, repo labels = `[bug, enhancement]` → `case` neutralized, query re-runs with the surviving `state:open`, `recovery.status='repaired'` + a note naming the missing label; count is the real open total, not `0`.
- Covers KTD8. `labels:["case"]` as the **only** filter (no state) → neutralized → fully unscoped → `recovery.status='unresolved'` (router will drop to RAG), **not** a whole-repo `'repaired'` count.
- Covers KTD6 union. a label real in repo B but absent from repo A → **valid** (not neutralized); assert validity is union, not per-repo intersection.
- Covers AE2. `labels:["bug"]` (valid in some connected repo) → no failure, **no** `recovery`, real filtered count stated plainly.
- Covers AE3 / R7. valid filter that genuinely matches zero → count `0`, **no** `recovery` (genuine zero, not flagged).
- Covers AE5. valid `state:open` + bogus `author:"frobnicate"` (fails `resolvePerson`) → author neutralized, state kept, `recovery.status='repaired'`, note names the dropped author.
- Edge: label-set fetch is memoized per (installation, repo) — repeated validation in one request issues one `/labels` call per repo (assert fetch count).
- Error path: a `/labels` fetch fails → degrade to `status='unresolved'` (don't crash), router falls back to RAG.
- Unchanged: a `state`/`type`-only request issues **no** validation fetch and emits no `recovery` (R2 common-path guard).

---

### U3. Trello skills self-heal (shared filter layer)

**Goal:** Validate Trello free-text args (`member`, `label`, `list`, `board`) against the in-memory board domain, neutralize bogus values, and return the recovery signal — healing every Trello skill via the shared filter path, at zero extra API cost.

**Requirements:** R1, R2, R7/KD6, KTD3, KTD4, KTD6, KTD8, KTD9.

**Dependencies:** U1.

**Files:**
- `apps/bot-worker/src/skills/trello/filter.ts` — two validation points: (a) `board` validates against `access.boards` **before** `collectCards` (a bogus board is neutralized → re-collect across all boards, so member/label/list then validate against a non-empty card universe); (b) `filterCards` validates `member`/`label`/`list` against the real names materialized on the collected `EnrichedCard`s, neutralizes bogus ones, assembles recovery.
- `apps/bot-worker/src/skills/trello/count.ts`, `by_member.ts` — surface the recovery signal from the filter result onto their `SkillResult` (primary surfaces; `recently_active`/`board_breakdown`/`list` inherit via the shared filter).
- `apps/bot-worker/test/skills/trello/count.test.ts`, `apps/bot-worker/test/skills/trello/by_member.test.ts` — tests.

**Approach:** `board` is the one arg whose neutralization needs a re-*fetch*: `collectCards` scopes boards by substring on board name, so a bogus board returns `[]` and would make every other arg look bogus against an empty universe — so validate `board` against `access.boards` first, and on a miss widen to all boards and re-collect (KTD3/feasibility). After collection, the real member/label/list names live on the `EnrichedCard`s — validation is **zero extra API calls** (R2/KTD6). Detection mirrors the filter's substring semantics (KTD9): a value is bogus iff **no** real domain value *contains* it as a case-insensitive substring — so spoken "Alice" against member "Alice Smith" is valid, not neutralized. `matchesText`'s "empty needle matches anything" quirk means a bogus member silently produces `0` today; detect-before-filter fixes it. `by_member` currently guards only the *empty* member case — generalize to bogus. Classification per KTD8: if another scope survives (board/list/label), `status='repaired'` + note; if the neutralized arg was the *only* filter so the result is the whole board(s), `status='unresolved'`. A valid value that genuinely matches no cards returns **no** `recovery` (R7).

**Patterns to follow:** the in-memory `filterCards` structure and `matchesText` substring semantics; `by_member.ts`'s existing empty-member guard, generalized. Use `_ctx.ts` Trello test helpers.

**Test scenarios** (`count.test.ts`, `by_member.test.ts`):
- Covers AE1 (Trello analogue). `trello_count` with `list:"Backlog"` + bogus `member:"Jraffe"` (members = `[Alice Smith, Bob Lee]`) → member neutralized (no member contains "Jraffe"), count re-run with surviving `list:"Backlog"`, `recovery.status='repaired'` + note; not a misleading `0`.
- Covers KTD8. bogus `member:"Jraffe"` as the **only** filter → neutralized → whole-board count → `recovery.status='unresolved'` (router drops to RAG), not a broad `'repaired'` count.
- Covers KTD9. spoken `member:"Alice"` against member "Alice Smith" → substring match → **valid**, no `recovery`, real filtered count (regression guard against over-neutralizing partials).
- Covers AE3 / R7. valid `label:"blocked"` matching zero cards → `0`, **no** `recovery` (genuine zero).
- Covers AE5. `by_member` with valid `board` + bogus `member` → member neutralized, board scope survives → `status='repaired'`, note names the dropped member.
- Board re-fetch: bogus `board:"Jraffe"` → neutralized against `access.boards`, re-collect across all boards, member/label validated against the non-empty universe (assert the empty-universe trap is avoided).
- Unchanged: filtering with only `due` (closed enum) issues no validation and emits no `recovery`.

---

### U4. Router safety-net in retrieval orchestration

**Goal:** Read the recovery signal at the tool-execution seam and make the keep-vs-drop decision — keep the repaired `toolSource` at `source[0]` + RAG on `'repaired'`, drop it to RAG-only on `'unresolved'` — and emit telemetry for the new suspect-success outcome. No new streaming path; flash-fix invariant preserved.

**Requirements:** R5, R6/KD4, KTD2, KTD7, KTD8.

**Dependencies:** U1 (reads the signal); soft-depends U2, U3 (for end-to-end behavior, but built against the contract). The router is agnostic to *why* a result is `'unresolved'` (KTD8 unscoped, transient fetch failure, or unsalvageable bogus arg all converge) — it acts on the status, it does not re-classify.

**Files:**
- `apps/bot-worker/src/retrieval.ts` — in the tool-execution block (after `const skillResult = await skill.handler(...)`, before `mergedSources` assembly): branch on `skillResult.recovery?.status`. `'unresolved'` → set `toolSource = null` (falls through to the existing RAG-only `mergedSources` path). `'repaired'` / absent → keep `toolSource` (already the default). Log a `skill.suspect` event mirroring the existing `skill.failed` telemetry shape (skillName, status, neutralized args).
- `apps/bot-worker/test/skills/retrieval-safety-net.test.ts` (new) — unit coverage for the seam (net-new — no test exists for `maybeRetrieveAndEmit`/`mergedSources` today).

**Approach:** The decision is purely a function of the structured signal — no re-invocation of the handler (the cleaned re-run already happened in-handler per KTD2). Because `mergedSources` is assembled and the keep-vs-drop decision is made **before** `runSynthesisAndBroadcast` is invoked, a dropped tool result never produces a `synthesisStart` — the flash-fix buffer-then-reveal-on-`done` contract is untouched (KTD7). The new test will likely need a thin extraction or a focused harness around the tool-execution/merge logic, since `maybeRetrieveAndEmit` is large; prefer testing the smallest decision function that takes `(skillResult, synthesisSources) → mergedSources | RAG-only` rather than the whole pipeline.

**Execution note:** Characterize the existing tool-execution → `mergedSources` behavior with a test before adding the branch — this seam is currently untested and feeds the just-fixed synthesis path.

**Patterns to follow:** the existing `SkillExecutionError` → `toolSource = null` → RAG-only fall-through (the `'unresolved'` branch is the same shape, on a different trigger); the existing `skill.failed` / `skill.done` log calls for the new `skill.suspect` telemetry.

**Test scenarios** (`apps/bot-worker/test/skills/retrieval-safety-net.test.ts`):
- Covers R6/KD4. `recovery.status='repaired'` → `toolSource` kept at `source[0]`, RAG cards follow; merged sources length = 1 + cards.
- Covers AE4 / R5. `recovery.status='unresolved'` → `toolSource` dropped, synthesis proceeds RAG-only (sources = cards only).
- No `recovery` → `toolSource` kept (unchanged behavior, regression guard).
- Existing `SkillExecutionError` still → RAG-only (unchanged).
- Telemetry: a suspect result emits a `skill.suspect` log with skillName + status (assert via captured logger).
- Flash-fix guard: a dropped (`'unresolved'`) tool result emits **no** `synthesisStart` before the RAG-only decision (assert the synthesis broadcaster sees the RAG-only source set, and no premature start fires).

---

### U5. Synthesis honesty for suspect/repaired results

**Goal:** Teach the synthesizer to never state a suspect/repaired tool result as hard fact — a static behavior rule in the cached system prefix, plus rendering the per-call caveat from the tool source so the model frames it honestly within the existing grounded-or-nothing contract.

**Requirements:** R4, KTD1, KTD7.

**Dependencies:** U1 (the `suspect` flag + caveat text).

**Files:**
- `packages/engine/src/synthesize/prompt.ts` — add a behavior rule to `SYSTEM_INSTRUCTIONS` (the static rules 1–11 list) instructing honest framing of a flagged/uncertain tool result; ensure `renderSource` surfaces the caveat for a `suspect` source (the caveat already rides in the tool source `text` from U1, so this may be rendering-only).
- `packages/engine/test/synthesize/prompt.test.ts` — tests.

**Approach:** The per-call suspicion **cannot** go in the cached system prefix (it's static, size-guarded, and not per-call) — it rides in the user-message tool source `text` (set by U1's `formatAsSource`). The system-prefix change is only the *static rule* ("if a source is flagged as uncertain or says a filter was dropped, do not assert its numbers as fact; say what was uncertain and lean on the other sources"). Keep any new few-shot in the deliberately-fictional "Marina" domain so the model can't recite the real stack. Adding instruction text grows the prefix — safe for the `HAIKU_CACHE_MIN_CHAR_PROXY` floor (it only gets larger).

**Honesty here is prompt-enforced on a Haiku-class model — probabilistic, not structural.** The static guarantee is KTD8, not this prompt: the genuinely dangerous case (a narrow question neutralized into a whole-repo/board answer) is classified `'unresolved'` and dropped to RAG *before* synthesis ever sees it, so the synthesizer only receives `'repaired'` results that still carry real scope. This rule covers the residual — framing a still-scoped repaired number honestly. The residual risk (a small model restating the salient number despite the caveat) is accepted and recorded in Risks; it is bounded by KTD8 removing the worst case.

**Patterns to follow:** the existing numbered behavior rules in `SYSTEM_INSTRUCTIONS`; the existing `STATUS:`-tag + `verifyCitations` grounded-or-nothing contract (extend it, don't add a parallel suspicion channel); the fictional-domain few-shots.

**Test scenarios** (`packages/engine/test/synthesize/prompt.test.ts`):
- The system prefix still satisfies the size/cache-floor guard after the new rule (existing assertion still passes; prefix only grew).
- `buildUserMessage` with a `suspect` tool source renders the caveat text in the source block (so the model sees it).
- A non-suspect tool source renders unchanged (regression guard for the tuned source format).
- Behavior-rule text is present in the prefix (string assertion) so the honesty instruction can't be silently dropped.
- Output-level (best-effort, recorded/replayed completion, not a live call): a `'repaired'` source with a real number and a "filter dropped" caveat → the model's answer hedges or attributes the number (does not state it bare). If a recorded fixture is impractical, mark this as a manual dogfood check in Verification rather than skipping the concern.

---

### U6. Eval regression coverage (AE-coverage definition-of-done + rendering smoke)

**Goal:** Honor the standing eval-regression convention with honest scoping: the **load-bearing** regression gate is the AE-tagged deterministic unit tests in U2/U3 (the convention's required home, since `replay.ts` cannot reach the skill/classifier path); add an explicit AE-coverage definition-of-done so no AE is silently uncovered, plus one golden row as a *rendering* smoke (clearly labeled as such, not a misparse gate).

**Requirements:** Eval convention (standing memory); R1.

**Dependencies:** U2, U3.

**Files:**
- `apps/bot-worker/eval/golden-questions.jsonl` — add the "open case GitHub issues" row with `expect_answer_contains` ground-truth terms and `expect_refusal: false`, **and a `note` stating it is a rendering smoke (the replay harness skips the skill path, so it does not gate the misparse fix)**. This prevents the row giving false confidence that the open-case class is eval-guarded.
- (Definition-of-done, not new tests) a checklist confirming AE1–AE5 each map to a named, passing scenario in `search_count.test.ts` / `count.test.ts` / `by_member.test.ts` — fold this into the U2/U3 acceptance, not a separate test file.

**Approach:** `replay.ts` replays the RAG/corpus path only, so a golden question provably cannot catch a skill-arg misparse — the unit tests in U2/U3 are the real gate. The golden row's value is narrow and stated honestly: it verifies the open-case question still *renders* a non-suppressed answer end-to-end (the harness scores a non-refusal answer with zero surviving citations as SUPPRESSED). The genuinely missing end-to-end coverage — exercising the skill/classifier path in the harness — is called out as a known blind spot (see Deferred to Implementation), not papered over. Keep `expect_answer_contains` terms non-question-echo, not the word "case".

**Test expectation:** none new — the golden row is data with an honest `note`; the behavioral assertions live in U2/U3. This unit's deliverable is the labeled golden row plus the AE-coverage definition-of-done on U2/U3.

---

## Scope Boundaries

### In scope
- The `SkillResult` recovery/confidence contract + `formatAsSource`/`SynthesisSource` plumbing (U1).
- Self-healing argument validation for the live GitHub and Trello skill families (U2, U3).
- The router safety-net keep-vs-drop decision + suspect-success telemetry (U4).
- Synthesis honesty for suspect/repaired results (U5).
- Eval-regression coverage (U6).

### Deferred for later
- Extending self-healing to future skills (Jira/Slack/Confluence) as they land — same `recovery` contract, applied per skill family. Includes `assignee` healing on the GitHub `by_assignee_*` skills (KTD4).
- The **agentic answerer** (a bounded tool-use loop with RAG context that composes multiple skills and self-corrects over several rounds) — the north star if true composition becomes needed and the latency budget allows.

### Non-goal: valid-but-wrong extraction
- This design catches only **non-existent** argument values. A *valid-but-wrong* extraction — a real domain value that isn't the one the user meant ("bug" heard as "bot" where both labels exist; a substring like "Jo" that matches two real members) — passes membership validation clean and is reported as fact. Catching it needs disambiguation or confirmation (agentic-answerer territory), explicitly out of scope here. This is why R1 is scoped to the non-existent-value class, not an unqualified "never wrong".

### Outside this product's identity
- Re-litigating what should be a skill vs RAG — the boundary stays as-is.
- Reworking the classifier prompt for extensibility as the source surface grows — that's the separate "routing manifest" thread (pending task U7), not this.
- Per-phrase classifier-prompt patching for specific misparses (origin KD5 — rely on structural self-healing instead).

### Deferred to Follow-Up Work
- Threading the live client into `SkillContext` to enable a generic engine-level validation wrapper. Not needed now (in-handler validation per KTD2 is sufficient and contained); revisit only if a third+ skill family makes the per-handler duplication costly.

---

## Risks & Dependencies

- **Flash-fix reintroduction (highest risk).** Recovery runs inside the `runSynthesisAndBroadcast` window that was just fixed to buffer-then-reveal grounded-or-nothing on `done`. Mitigation (KTD7): the keep-vs-drop decision is made on `mergedSources` *before* synthesis is invoked, so a dropped tool result never emits a premature `synthesisStart`. U4 includes an explicit guard test. Do not move the recovery decision into the streaming/`done` path.
- **Tuned summary strings / byte-equality tests.** The synthesizer was tuned against exact skill `summary` text. Mitigation (KTD1): `recovery` is purely additive; `summary`/`items` rendering is unchanged; U1's first test is a byte-identical regression guard.
- **GitHub label-fetch latency (corrected scope).** A `GET /repos/{owner}/{repo}/labels` fires per connected repo whenever a `labels` arg is present — including **valid** label queries, not just misfires (so R2's "common path pays nothing" holds only for the *safe-enum-only* subset, not for label-filtered queries; the cost is one small GET per connected repo, memoized within the request). Mitigation: the request-scoped memo collapses repeats within a request; if steady-state label queries prove hot, lift to a cross-request per-(org, repo) cache with a short TTL (deferred — start request-scoped). A failed fetch degrades to `'unresolved'` (RAG fallback), never a crash.
- **Synthesis honesty is prompt-only on a Haiku model (residual, accepted).** R4's "never state a suspect result as fact" is enforced by a prompt rule against a small model — probabilistic, not structural. The model may still restate a salient repaired number despite the caveat. Mitigation (KTD8): the genuinely dangerous case (narrow question → whole-repo/board answer) is classified `'unresolved'` and dropped to RAG *before* synthesis, so the model only ever frames still-scoped repaired results; the residual (hedging a legitimately-scoped repaired number) is bounded and accepted, with a best-effort output-level test in U5.
- **Valid-but-wrong extraction is uncaught (scoped non-goal).** Membership validation cannot distinguish a real-but-wrong value from the intended one (see Scope Boundaries). R1 is scoped accordingly; this is a known limit of the deterministic approach, not a defect to fix here.
- **`maybeRetrieveAndEmit` is large and untested.** U4 introduces the first test at this seam; prefer extracting the smallest pure keep-vs-drop decision function over testing the whole pipeline (Execution note on U4).
- **Replay harness blind spot.** `replay.ts` does not exercise the skill/classifier path, so eval golden questions cannot be the primary regression gate — the deterministic unit tests are (U6 approach).

---

## Deferred to Implementation

- Final field names and exact shape of `SkillResult.recovery` (directional sketch in HTD; settled in U1).
- Exact module path of the GitHub validation helper (`self-heal.ts` proposed; confirm when touching the code — U2).
- **Only** fine-tuning of the `'repaired'` vs `'unresolved'` split for *partially-scoped* re-runs (KTD8 already fixes the load-bearing rule: a fully-unscoped re-run → `'unresolved'`). The remaining judgment — whether a weakly-scoped re-run is "useful enough" to keep — is a tuning detail, not a safety decision (U2/U3).
- Whether U4's keep-vs-drop logic is extracted into a standalone function or inlined with a characterization test wrapped around it (U4 Execution note).
- **Known blind spot (not in scope to fix here):** `replay.ts` does not exercise the skill/classifier path, so there is no *end-to-end* harness gate for arg-misparse regressions — only the U2/U3 unit tests. Extending the harness to replay the skill path is the real follow-up if an end-to-end gate is wanted (U6 calls this out honestly rather than implying the golden row covers it).

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-02-skills-rag-robustness-requirements.md`.
- Skill contract + formatter: `packages/engine/src/skills/contract.ts` (`SkillResult`, `Skill`, `SkillContext`, `formatAsSource`, `SkillExecutionError`), `packages/engine/src/skills/registry.ts`, registry assembly in `apps/bot-worker/src/skills/index.ts`.
- GitHub skills: `apps/bot-worker/src/skills/github/` — `search_count.ts` (`buildSearchQualifiers`), `person.ts` (`resolvePerson`, the existing author-validation template), `client.ts`/`live-helpers.ts` (`getJson`, `firstRepo`), `filter.ts`.
- Trello skills: `apps/bot-worker/src/skills/trello/` — `filter.ts` (`collectCards`/`filterCards`, in-memory domain), `client.ts` (`fetchEnrichedCards`, `EnrichedCard.members`/`labels`), `count.ts`, `by_member.ts`, `source-resolver.ts` (`access.boards`).
- Router: `packages/engine/src/router/` — `contract.ts` (`ClassifierResult`), `anthropic-classifier.ts`, `heuristic.ts` (`isToolShaped`).
- Orchestration: `apps/bot-worker/src/retrieval.ts` — `maybeRetrieveAndEmit`, tool-execution block, `mergedSources` assembly, `runSynthesisAndBroadcast` (flash-fix).
- Synthesis: `packages/engine/src/synthesize/prompt.ts` (`SYSTEM_INSTRUCTIONS`, `renderSource`, `buildUserMessage`, `HAIKU_CACHE_MIN_CHAR_PROXY`), `packages/engine/src/synthesize/contract.ts` (`SynthesisSource`).
- Eval harness + convention: `apps/bot-worker/eval/golden-questions.jsonl`, `apps/bot-worker/eval/replay.ts` (grounding-aware, skips skill/classifier path), and the standing memory `eval-regression-coverage`.
- Existing tests to extend: `packages/engine/test/skills/contract.test.ts`, `apps/bot-worker/test/skills/github/search_count.test.ts` (+ `person.test.ts`, `_live-ctx.ts`), `apps/bot-worker/test/skills/trello/count.test.ts` + `by_member.test.ts` (+ `_ctx.ts`), `packages/engine/test/synthesize/prompt.test.ts`.
