---
title: "feat: Live GitHub API skills — assignees + issue progress"
type: feat
status: active
date: 2026-05-29
origin: docs/brainstorms/github-live-skills-requirements.md
---

# feat: Live GitHub API Skills — Assignees + Issue Progress

## Overview

Four new skills registered alongside the existing corpus-backed GitHub skills. Each hits the live GitHub REST API at query time using the existing `GithubClient` and `GITHUB_TOKEN`:

| Skill | Question |
|---|---|
| `github_issue_assignees` | Who is issue X assigned to? |
| `github_by_assignee_list` | What issues are assigned to person X? |
| `github_by_assignee_count` | How many issues does person X have? |
| `github_issue_progress` | Have we made progress on issue X? (state + last 3–5 events) |

Person identification uses **try-as-login then GitHub user-search fallback** (D2). All four skills target a single env-configured repo (`UPWELL_GITHUB_REPO`); multi-source routing is deferred to issue #17.

---

## Problem Frame

(See origin: `docs/brainstorms/github-live-skills-requirements.md`)

Corpus-backed GitHub skills answer aggregation questions over indexed data, but person- and item-specific questions need freshness the corpus doesn't have. An issue reassigned after the last `upwell index` run silently returns the stale assignee. The user has confirmed live API calls are within scope (still read-only).

---

## Requirements Trace

- R1. `github_issue_assignees` skill takes an issue number and returns current assignees.
- R2. `github_by_assignee_list` skill takes a person token and returns currently-assigned issues.
- R3. `github_by_assignee_count` skill takes a person token and returns a count.
- R4. `github_issue_progress` skill takes an issue number and returns state + assignees + labels + last 3–5 events.
- R5. All four skills target `UPWELL_GITHUB_REPO`. If absent, skills are not registered.
- R6. Person identification uses try-as-login + GitHub user-search fallback.
- R7. Skills reuse `GITHUB_TOKEN`. If missing, skills are not registered.
- R8. API errors propagate as `SkillExecutionError`; synthesizer falls through to graceful refusal.
- R9. Per-skill telemetry: `skill.start`, `skill.done` with latency, `skill.failed` with error code.
- R10. Classifier prompt is extended with worked examples for each new intent.

---

## Scope Boundaries

- No per-utterance repo extraction (deferred to issue #17 — multi-source routing).
- No API-response caching across utterances or meetings.
- No write operations to GitHub (identity constraint per origin's "Outside this product's identity").
- No new skills for other connectors (Confluence/Jira/Trello) — those wait on multi-source routing.
- No rate-limit-aware throttling beyond what `GithubClient` already provides (it throws `RateLimitedError` on 429).

### Deferred to Follow-Up Work

- Cross-source classifier routing: GitHub issue #17, separate brainstorm + plan.
- Response caching (TTL keyed by `(skill, args)`): revisit if dogfood shows the same issue being looked up multiple times per meeting.

---

## Context & Research

### Relevant Code and Patterns

- `apps/daemon/src/connectors/github/client.ts` — `GithubClient` with `get(auth, path, query)` and `getJson<T>(auth, path, query)`. Handles auth, rate-limit, error mapping. **Skills reuse this directly — no new HTTP client.**
- `apps/daemon/src/connectors/github/auth.ts` — defines `AuthResult` discriminated union (`{kind:'pat',token} | {kind:'oauth',accessToken}`). For skills, build `{kind:'pat',token: GITHUB_TOKEN}`.
- `apps/daemon/src/connectors/contract.ts` — `RateLimitedError`, `ConnectorAuthError` shapes. Skills catch these and convert to `SkillExecutionError`.
- `apps/daemon/src/skills/contract.ts` — `Skill`, `SkillContext`, `SkillResult` (`kind: 'count' | 'list' | 'detail'`), `SkillExecutionError`. Live skills don't use `SkillContext.db` (unused for these); the contract allows it.
- `apps/daemon/src/skills/github/count.ts`, `list.ts`, `by_author.ts`, `recently_updated.ts` — existing corpus skills. New skills follow the same shape: a `const xxxSkill: Skill = { source, name, description, inputSchema, handler }` object with a `handler(args, ctx)` async function.
- `apps/daemon/src/skills/github/index.ts` — exports `skills` array. New skills append here.
- `apps/daemon/src/router/prompt.ts` — cacheable classifier prompt with worked examples. Adding ~12 more examples for the new intents — stays well above the 4096-token cache floor.
- `apps/daemon/src/cli/serve.ts` — wires the registry. Adds env-var checks for `UPWELL_GITHUB_REPO` and `GITHUB_TOKEN`, conditional skill registration.
- `apps/daemon/src/connectors/github/types.ts` — `GithubUser`, `GithubIssue` types already exist (assignees, labels, state, etc.). Reuse for skill response parsing.

### Institutional Learnings

- The router classifier prompt is currently ~18.2k chars; `HAIKU_CACHE_MIN_CHAR_PROXY` in `apps/daemon/src/router/prompt.ts` is 16k (proxy for the 4096-token Haiku cache floor). Adding ~12 worked examples (~3–5k chars) pushes the total to ~21–23k. Far above the cache floor; far below Anthropic's max system prompt. Caching continues to engage; cache-creation cost is slightly higher on the first call after each 5-minute eviction.
- Anthropic tool names match `^[a-zA-Z0-9_-]{1,128}$` — underscores OK, dots/slashes rejected (lesson from router skill renames).
- Skill `handler` results flow through `formatAsSource(result, name, args)` to become a `SynthesisSource` consumed by the synthesizer. `kind: 'detail'` results render the `summary` + optional `items` list. Rich timeline output for `github_issue_progress` fits cleanly.

### External References

- GitHub REST API reference for the endpoints used: `/repos/{owner}/{repo}/issues/{number}`, `/repos/{owner}/{repo}/issues/{number}/timeline` (requires `Accept: application/vnd.github.mockingbird-preview+json` historically, now `application/vnd.github+json`), `/repos/{owner}/{repo}/issues?assignee=...`, `/search/users?q=...`.
- Rate limit: 5000 req/hr with a PAT. Typical meeting: under 20 skill invocations. No concern.

---

## Key Technical Decisions

- **Reuse `GithubClient` directly; no new HTTP wrapper.** The existing client handles auth, rate-limit, error mapping. Skills just call `client.getJson<T>(auth, path, query)`. The unused `SkillContext.db` is ignored — `Skill` contract permits this.
- **Single `LiveSkillContext` shape passed at skill construction time.** Rather than extending `SkillContext` (which would force corpus skills to ignore new fields), each live skill is built as a factory that closes over `{client, auth, repo, resolvePerson}`. Registration in `serve.ts` calls the factory once at meeting start, producing four ordinary `Skill` objects that get pushed into the same registry alongside the corpus skills (no parallel registration path).
- **`resolvePerson(token)` is a shared helper, NOT a method on the client.** Lives in `apps/daemon/src/skills/github/person.ts`. Tries `/users/{token}` first; on a 404 specifically (caught and suppressed by the resolver — does NOT propagate through `mapGithubError`), falls back to `/search/users` and picks the top match. Returns `{login, resolved} | null`.
- **Contract extensions — `SkillExecutionError` gains a `code` field; `SkillFailureCode` and the pipeline are widened.** The existing `SkillExecutionError(skillName, message, options?)` does not carry a code; the pipeline catch hardcodes `code: 'execution-error'`. R9's per-skill-failure-code telemetry requires:
  1. `SkillExecutionError` constructor extended to `(skillName, message, options?: ErrorOptions & { code?: SkillExecutionCode })` with `readonly code: SkillExecutionCode` on the instance. `SkillExecutionCode = 'rate-limit' | 'auth-error' | 'not-found' | 'unknown' | 'execution-error'`. Default `'execution-error'` preserves existing corpus-skill behavior.
  2. `SkillFailureCode` (`apps/daemon/src/retrieve/contract.ts`) extended to include the new codes.
  3. `pipeline.ts` catch (the existing `code: 'execution-error'` site) reads `err instanceof SkillExecutionError ? err.code : 'execution-error'`.
- **`ConnectorAuthError` gains an optional `status` field; `GithubClient.get` populates it.** Today the same class is thrown for 401/403/404/other with the status only encoded in the message string. Inspecting the message is fragile. The fix is one-line:
  1. `ConnectorAuthError` adds `readonly status?: number`.
  2. `GithubClient.get` passes `status` at every throw site (lines 55–69 and 79–83). All existing callers (indexer auth flow) ignore the new field — no behavior change.
  3. `mapGithubError` reads `.status` directly (404 → not-found, 401/403 → auth-error). No string parsing.
- **Person token must validate against GitHub's actual login charset BEFORE URL interpolation.** Anthropic's `{type: 'string'}` only enforces non-empty; it does NOT block `/`, `..`, whitespace, or other URL metacharacters. `resolvePerson` rejects tokens not matching `^[A-Za-z0-9_-]{1,39}$` (GitHub's documented login format) and returns null — same outcome as "no user found." Without this, a spoken phrase containing a slash (transcription artifact, joke, or attack) hits an unintended GitHub API endpoint.
- **Search query fallback strips qualifier syntax.** GitHub search interprets qualifiers like `org:victim` within the `q` parameter after URL decoding. The resolver only enters the search-fallback path with a token that already passed the login-charset regex above — so by construction it cannot contain `:` or whitespace. No additional stripping needed; the upstream validation is the gate.
- **`issue_number` schema includes `minimum: 1`.** Already implied by "Issue-number-keyed skills take `{ issue_number: integer }`" — making the minimum explicit in the JSON Schema closes the prose-vs-implementation gap. `0` and negative values become impossible at the classifier-input layer.
- **Timeline event filtering.** GitHub's `/issues/{num}/timeline` returns many event types (`commented`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `renamed`, `closed`, `reopened`, `referenced`, `mentioned`, plus ~20 others). `github_issue_progress` keeps only the 5 most-recently-occurring of the **load-bearing** types (`commented`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `closed`, `reopened`, `merged`) — the rest are noise for a meeting answer.
- **All four skills register together or not at all.** If either `UPWELL_GITHUB_REPO` or `GITHUB_TOKEN` is missing, none of the four register; serve.ts logs `github.live.disabled reason=no-repo` or `reason=no-token`. The corpus skills stay independent and register regardless.
- **No retries inside the skills.** `GithubClient` doesn't retry on its own; skills don't add retries either. A flaky API surfaces as `SkillExecutionError` which the pipeline turns into a graceful synthesizer refusal. Retries can be added in `GithubClient` later if dogfood shows them needed.
- **Tool input schemas.** Issue-number-keyed skills take `{ issue_number: integer (≥1) }`. Person-keyed skills take `{ person: string (non-empty) }`. JSON Schema validation is enforced by Anthropic against the tool definition.

---

## Open Questions

### Resolved During Planning

- *Where does the API client live?* Reuse `apps/daemon/src/connectors/github/client.ts` — no new client.
- *Where does the resolvePerson helper live?* `apps/daemon/src/skills/github/person.ts` (new file).
- *Where does `LiveSkillContext` live?* `apps/daemon/src/skills/github/live-context.ts` (new file; type-only).
- *Which timeline endpoint?* `/repos/{owner}/{repo}/issues/{number}/timeline` (returns the rich event mix).
- *How many timeline events?* 5 most-recent load-bearing events.
- *Should resolvePerson surface the mapping to the user?* In the skill result's `summary` ("Resolved 'nathan' → 'Nath5'"). Synthesizer decides whether to mention it.

### Deferred to Implementation

- Exact GitHub user-search query phrasing — `q=<token>+in:login+in:name+in:fullname` may need tuning by experimenting with real searches.
- Exact load-bearing event-type set for `github_issue_progress` — start with the list above, drop or add based on what dogfood reveals.
- Whether `github_by_assignee_list` returns paginated results or just the first page (30 items) — first-page-only is fine for v1; revisit if the count skill shows users with 50+ open issues.

---

## Implementation Units

- [x] U1. **Live-skill foundation: contract extensions + LiveSkillContext + resolvePerson + GitHub error mapping**

**Goal:** Shared infrastructure for the four live skills. Includes contract changes (`SkillExecutionError` gains `code`; `ConnectorAuthError` gains `status`; pipeline reads the code from the thrown error; `SkillFailureCode` widened) that the live skills depend on for typed error telemetry. Plus the live-skill context type, person-resolution helper with token validation, and `mapGithubError` utility.

**Requirements:** R6, R8, R9 (foundation for telemetry codes)

**Dependencies:** None

**Files:**
- Modify: `apps/daemon/src/skills/contract.ts` — extend `SkillExecutionError` with `code` field; export `SkillExecutionCode` union
- Modify: `apps/daemon/src/retrieve/contract.ts` — widen `SkillFailureCode` to add `'rate-limit' | 'auth-error' | 'not-found' | 'unknown'`
- Modify: `apps/daemon/src/retrieve/pipeline.ts` — catch block reads `err.code` when `err instanceof SkillExecutionError`
- Modify: `apps/daemon/src/connectors/contract.ts` — add optional `readonly status?: number` to `ConnectorAuthError`
- Modify: `apps/daemon/src/connectors/github/client.ts` — populate `status` at every `ConnectorAuthError` throw site
- Create: `apps/daemon/src/skills/github/live-context.ts`
- Create: `apps/daemon/src/skills/github/person.ts`
- Create: `apps/daemon/src/skills/github/error.ts`
- Test: `apps/daemon/test/skills/github/person.test.ts`
- Test: `apps/daemon/test/skills/github/error.test.ts`
- Test: `apps/daemon/test/connectors/github/client.test.ts` (extend) — assert `status` field populated on the thrown error for 401/403/404
- Test: `apps/daemon/test/retrieve/pipeline.test.ts` (extend) — assert pipeline emits `skillFailed` with the SkillExecutionError's code instead of hardcoded `'execution-error'`

**Approach:**
- **Contract changes first** (test-first; existing tests pin the unchanged behavior for corpus skills):
  - `SkillExecutionError`: add `readonly code: SkillExecutionCode = 'execution-error'` to instances. Constructor accepts optional `code` in the options bag; defaults to `'execution-error'` to preserve corpus-skill behavior. Export `SkillExecutionCode = 'rate-limit' | 'auth-error' | 'not-found' | 'unknown' | 'execution-error'`.
  - `SkillFailureCode`: widen union to include the new live-skill codes.
  - `pipeline.ts` catch: `const code = err instanceof SkillExecutionError ? err.code : 'execution-error'`.
  - `ConnectorAuthError`: add `readonly status?: number`. Constructor accepts it in options bag.
  - `GithubClient.get`: pass `status: 401` / `403` / `404` / actual code at each throw site.
- `live-context.ts` exports `LiveSkillContext` interface: `{ client: GithubClient; auth: AuthResult; repo: { owner: string; name: string } }`. Type-only file; no runtime exports.
- `person.ts` exports `resolvePerson(token: string, ctx: LiveSkillContext, signal?: AbortSignal): Promise<{ login: string; resolved: 'literal' | 'search'; } | null>`.
  - **Validate token** against `^[A-Za-z0-9_-]{1,39}$` (GitHub's login charset). If it doesn't match, return null immediately — no API calls fire.
  - Try `client.getJson<GithubUser>(auth, '/users/${token}')` wrapped in a try/catch. Catch `ConnectorAuthError` specifically when `err.status === 404` and fall through; let any other error propagate (the skill handler maps it via `mapGithubError`).
  - On 404 fallthrough, call `client.getJson(auth, '/search/users', { q: token + ' in:login in:name in:fullname' })` and return the top match's login as `{login, resolved: 'search'}`.
  - If search returns no results, return null.
- `error.ts` exports `mapGithubError(err: unknown, skillName: string): SkillExecutionError`. Reads `err.status` from `ConnectorAuthError` (no message parsing). `RateLimitedError` → `code: 'rate-limit'`. `ConnectorAuthError` with `status === 404` → `code: 'not-found'`. `ConnectorAuthError` with `status === 401 || status === 403` → `code: 'auth-error'`. Everything else → `code: 'unknown'`. **Preserves the source error's message verbatim** so `GithubClient`'s token-redaction stays intact through the chain.

**Execution note:** Test-first for the contract changes — existing corpus-skill failure tests must continue to log `code: 'execution-error'` (default preserved). The new typed codes only emerge for live skills.

**Patterns to follow:**
- `apps/daemon/src/skills/contract.ts` — `SkillExecutionError` constructor + codes.
- `apps/daemon/src/connectors/github/client.ts` — existing throw sites at lines 55–69 and 79–83.

**Test scenarios:**
- Contract: existing pipeline tests still pass — corpus-skill failures emit `code: 'execution-error'` (default).
- Contract: pipeline emits `skillFailed { code: 'rate-limit' }` when handler throws `new SkillExecutionError(name, msg, {code: 'rate-limit'})`.
- Contract: GithubClient 401 response → thrown error has `status === 401`; 404 → `status === 404`.
- Happy path (resolvePerson, literal): `resolvePerson('Nath5', ctx)` — `getJson` returns a user → returns `{ login: 'Nath5', resolved: 'literal' }`.
- Happy path (resolvePerson, search fallback): `resolvePerson('nathan', ctx)` — literal lookup throws `ConnectorAuthError(status: 404)`, search returns one match → returns `{ login: 'Nath5', resolved: 'search' }`.
- Edge case (resolvePerson, invalid charset): `resolvePerson('nathan/secrets', ctx)` → returns null WITHOUT making any API call. Verify via fake-fetch call count.
- Edge case (resolvePerson, empty token): `resolvePerson('', ctx)` → null, no API call.
- Edge case (resolvePerson, login at boundary): exactly 39 alphanumeric chars → passes validation; 40 → null.
- Edge case (resolvePerson, both miss): literal 404 + search returns `[]` → null.
- Error path (resolvePerson, network during literal): non-404 error (e.g., 500) → propagates (caller wraps via mapGithubError).
- Error path (resolvePerson, rate-limit during literal): `RateLimitedError` → propagates.
- Error path (resolvePerson, rate-limit during search fallback): `RateLimitedError` → propagates.
- Happy path (mapGithubError): `mapGithubError(new RateLimitedError(...))` → `SkillExecutionError(code: 'rate-limit')`.
- Happy path (mapGithubError): `mapGithubError(new ConnectorAuthError('msg', [], {status: 404}))` → `code: 'not-found'`.
- Happy path (mapGithubError): `mapGithubError(new ConnectorAuthError('msg', [], {status: 401}))` → `code: 'auth-error'`.
- Happy path (mapGithubError): `mapGithubError(new Error('socket hang up'))` → `code: 'unknown'`.
- **Token non-leakage:** `mapGithubError(new ConnectorAuthError('GitHub auth failed (401): Bearer ghp_secret123', [], {status: 401}))` — the resulting `SkillExecutionError.message` does NOT contain `ghp_secret123` (relies on `GithubClient`'s existing `redactString` on the source). The redaction chain is preserved end-to-end.

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- Existing corpus-skill failure tests still pass with `code: 'execution-error'` as the default (no regression).

**Patterns to follow:**
- `apps/daemon/src/skills/contract.ts` — `SkillExecutionError` constructor + codes.
- `apps/daemon/src/connectors/github/client.ts` — `getJson<T>(auth, path, query)` signature.

**Test scenarios:**
- Happy path (person, literal): `resolvePerson('Nath5', ctx)` — `getJson` returns a user → returns `{ login: 'Nath5', resolved: 'literal' }`.
- Happy path (person, search fallback): `resolvePerson('nathan', ctx)` — literal lookup throws 404, search returns one match `{ login: 'Nath5' }` → returns `{ login: 'Nath5', resolved: 'search' }`.
- Edge case (person, both miss): both literal and search return no match → returns `null`.
- Edge case (person, search returns multiple): top match (first item) is used.
- Error path (network during literal): non-404 error → propagates (caller wraps via mapGithubError).
- Happy path (error mapping): `mapGithubError(new RateLimitedError(...))` → `SkillExecutionError(code: 'rate-limit')`.
- Happy path (error mapping): `mapGithubError(new ConnectorAuthError('GitHub request failed (404): ...'))` → `code: 'not-found'`.
- Happy path (error mapping): `mapGithubError(new ConnectorAuthError('GitHub auth failed (401): ...'))` → `code: 'auth-error'`.
- Happy path (error mapping): `mapGithubError(new Error('socket hang up'))` → `code: 'unknown'`.

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- The three new files are imported only from sibling skill files (not leaking outside `skills/github/`).

---

- [x] U2. **Issue-number-keyed skills: `github_issue_assignees` + `github_issue_progress`**

**Goal:** Two skills that take an issue number and call `/repos/{owner}/{repo}/issues/{number}` (assignees) and `/repos/{owner}/{repo}/issues/{number}/timeline` (progress).

**Requirements:** R1, R4, R8, R9

**Dependencies:** U1

**Files:**
- Create: `apps/daemon/src/skills/github/issue_assignees.ts`
- Create: `apps/daemon/src/skills/github/issue_progress.ts`
- Test: `apps/daemon/test/skills/github/issue_assignees.test.ts`
- Test: `apps/daemon/test/skills/github/issue_progress.test.ts`

**Approach:**
- Both skills export a **factory** `buildIssueAssigneesSkill(ctx: LiveSkillContext): Skill` (and same shape for progress). The factory closes over `ctx`, returns a fresh `Skill` with the handler bound. Registration calls the factory once at meeting start in serve.ts.
- `github_issue_assignees.ts`:
  - Input schema: `{ type: 'object', properties: { issue_number: { type: 'integer', minimum: 1 } }, required: ['issue_number'] }`. The `minimum: 1` is required — `0` and negatives are invalid GitHub issue numbers and could produce malformed URLs.
  - Handler: `client.getJson<GithubIssue>(auth, \`/repos/${owner}/${name}/issues/${issue_number}\`)`. Errors caught and re-thrown via `mapGithubError` from U1.
  - Returns `SkillResult { kind: 'detail', summary: 'Issue #14 is assigned to <login1>, <login2>.', items: [{title: login1, url: 'https://github.com/<login1>'}, ...] }`.
  - Empty assignees → summary `'Issue #14 has no current assignees.'`.
- `github_issue_progress.ts`:
  - Input schema: same shape with `minimum: 1`.
  - Handler: fetch the issue (for state + title) + fetch `/issues/{number}/timeline`. First page (no pagination) — sufficient for "recent" events.
  - **Accept header note:** the timeline endpoint is served under the default `application/vnd.github+json` Accept value that `GithubClient.get` hardcodes (line 41). If a future GitHub API change reverts to requiring the legacy `mockingbird-preview` Accept for some event types, `GithubClient.get` needs a per-request Accept override — out of scope for v1.
  - Filter timeline to load-bearing event types (`commented`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `closed`, `reopened`, `merged`). Sort by `created_at` desc, take 5.
  - Returns `SkillResult { kind: 'detail', summary: 'Issue #14 (open): "Add auth flow". <event1>. <event2>. ...', items: events formatted as { title: 'commented by jamie · 2 days ago', subtitle: 'Still blocked on the auth migration', url: comment.html_url } }`.

**Execution note:** Test-first for the response parsing. Real GitHub timeline payloads have many shapes; pin them via fixtures (recorded JSON) so the parser doesn't drift on a refactor.

**Patterns to follow:**
- `apps/daemon/src/skills/github/count.ts` — skill object shape.
- `apps/daemon/src/skills/contract.ts` — `SkillResult` builder.
- `apps/daemon/test/router/anthropic-classifier.test.ts` — fetch-mocking pattern for HTTP-driven skills (`captureCalls`, Response-builder helpers).

**Test scenarios:**
- Happy path (assignees, 2 people): issue with `assignees: [{login: 'a'}, {login: 'b'}]` → summary mentions both, items has 2.
- Happy path (assignees, none): `assignees: []` → summary 'no current assignees'.
- Happy path (progress, 8 events): 8 load-bearing events in timeline → top 5 chronologically newest survive.
- Happy path (progress, mixed event types): timeline mixes load-bearing and noise (e.g., `referenced`, `mentioned`) → noise excluded.
- Edge case (progress, no events): empty timeline → summary describes state only ("Issue #14 (open) — no recent activity.").
- Edge case (issue not found): `client.getJson` throws 404 → handler throws `SkillExecutionError(code: 'not-found', message)`.
- Error path (rate-limited): `client.getJson` throws `RateLimitedError` → handler throws `SkillExecutionError(code: 'rate-limit')`.
- Error path (network): `client.getJson` throws generic Error → handler throws `SkillExecutionError(code: 'unknown')`.
- Integration: factory output is a valid `Skill` — `inputSchema` has `issue_number: integer`, `handler` returns a Promise.

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- Manual fixture review: at least one real GitHub timeline payload (anonymized) is included in test fixtures.

---

- [x] U3. **Person-keyed skills: `github_by_assignee_list` + `github_by_assignee_count`**

**Goal:** Two skills that take a person token, resolve it via `resolvePerson` (U1), and call `/repos/{owner}/{repo}/issues?assignee={login}&state=open` to list or count.

**Requirements:** R2, R3, R6, R8, R9

**Dependencies:** U1

**Files:**
- Create: `apps/daemon/src/skills/github/by_assignee_list.ts`
- Create: `apps/daemon/src/skills/github/by_assignee_count.ts`
- Test: `apps/daemon/test/skills/github/by_assignee_list.test.ts`
- Test: `apps/daemon/test/skills/github/by_assignee_count.test.ts`

**Approach:**
- Same factory pattern as U2: `buildByAssigneeListSkill(ctx)` / `buildByAssigneeCountSkill(ctx)`.
- Both:
  1. Call `resolvePerson(person, ctx)`. If null → return `SkillResult { kind: 'detail', summary: "Couldn't find a GitHub user matching '<token>'." }`.
  2. Call `client.getJson<GithubIssue[]>(auth, '/repos/{owner}/{name}/issues', { assignee: login, state: 'open' })`.
  3. List: return `kind: 'list'`, summary `'<login> has N open issues:'`, items: each issue as `{ title, url, subtitle: '#<number> · <state>' }`.
  4. Count: return `kind: 'count'`, summary `'<login> has N open issues.'`. No items list.
- If `resolvePerson` resolved via search (not literal), include that in the summary: `'Resolved "nathan" → "Nath5". Nath5 has 7 open issues.'` (trust signal).
- First-page-only (30 items) per Key Technical Decisions — pagination deferred.
- Input schema: `{ person: string }` (non-empty). Required.

**Patterns to follow:**
- U1's `resolvePerson` (now exists).
- `apps/daemon/src/skills/github/by_author.ts` — closest existing analog (returns a list of docs filtered by author).
- `apps/daemon/src/skills/contract.ts` — `kind: 'count'` and `kind: 'list'` shape.

**Test scenarios:**
- Happy path (list, literal): `person: 'Nath5'` resolves literal → issues endpoint returns 3 → summary mentions count 3, items has 3.
- Happy path (list, search-resolved): `person: 'nathan'` resolves via search to 'Nath5' → summary includes "Resolved 'nathan' → 'Nath5'".
- Happy path (count, basic): same as list but `kind: 'count'`, no items.
- Edge case (no issues): `assignee` returns `[]` → summary `'<login> has 0 open issues.'`, items empty (list) or 0 (count).
- Edge case (person unresolved): `resolvePerson` returns null → summary `"Couldn't find a GitHub user matching '<token>'."`, no API call to issues endpoint.
- Edge case (first-page truncation): issues endpoint returns 30 items → all 30 in items list (no pagination, documented in summary as 'showing first 30').
- Error path (rate-limit during resolvePerson): propagates as `SkillExecutionError(code: 'rate-limit')`.
- Error path (rate-limit during issues query): same.
- Integration: factory output is a valid `Skill` with `kind: 'count' | 'list'` matching the skill purpose.

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.

---

- [x] U4. **Classifier prompt extension + serve.ts wiring + .env.example**

**Goal:** Teach the router classifier to pick the 4 new skills via worked examples, and conditionally register them in serve.ts when `UPWELL_GITHUB_REPO` + `GITHUB_TOKEN` are both present.

**Requirements:** R5, R7, R10

**Dependencies:** U2, U3

**Files:**
- Modify: `apps/daemon/src/router/prompt.ts` — append ~12 worked examples covering the 4 new intents
- Modify: `apps/daemon/src/skills/github/index.ts` — export the 4 factory functions (`buildIssueAssigneesSkill`, `buildByAssigneeListSkill`, `buildByAssigneeCountSkill`, `buildIssueProgressSkill`) alongside the existing `skills: readonly Skill[]` corpus-skill array. Factories are NOT in `skills` — they're called at meeting start in serve.ts.
- Modify: `apps/daemon/src/cli/serve.ts` — env-var check, build `LiveSkillContext`, register the 4 factory outputs alongside the corpus skills
- Modify: `.env.example` — add `UPWELL_GITHUB_REPO=owner/name` (uncommented? or with example?)
- Test: `apps/daemon/test/router/anthropic-classifier.test.ts` — extend with classification tests for the 4 new intents (optional, see below)

**Approach:**
- Worked examples in prompt.ts cover:
  - "Who is issue 14 assigned to?" → `github_issue_assignees { issue_number: 14 }`
  - "What issues does Nathan have?" → `github_by_assignee_list { person: 'Nathan' }`
  - "How many issues does Jamie have open?" → `github_by_assignee_count { person: 'Jamie' }`
  - "Have we made progress on issue 14?" → `github_issue_progress { issue_number: 14 }`
  - "What's the status of issue 7?" → `github_issue_progress { issue_number: 7 }`
  - "Who's working on the auth migration issue?" → `github_issue_assignees` (model extracts the issue number from context if known; otherwise refusal text)
  - Plus 5-6 "negative" examples confirming the corpus skills still win for their domains (e.g., "how many open issues" still routes to `github_count`, not `github_by_assignee_count`).
- serve.ts (inside `startMeeting()`, where `skillRegistry` is already built):
  - Reads `UPWELL_GITHUB_REPO` (e.g., `Nath5/upwell`), splits on `/` to `{ owner, name }`.
  - Reads `GITHUB_TOKEN` via `optionalEnv` (already used by the indexer).
  - If both present: build `LiveSkillContext = { client: new GithubClient(), auth: {kind: 'pat', token}, repo: {owner, name} }`, call the 4 factories to produce 4 plain `Skill` objects, register each via `skillRegistry.register(skill)` — same registration path as corpus skills. Log `github.live.enabled repo=<owner/name> skills=4`.
  - If either absent: log `github.live.disabled reason=no-repo` or `reason=no-token`. Corpus skills register as before.
- The `LiveSkillContext` lives for the entire meeting (built once per `startMeeting`); skills close over it. No per-call ctx threading needed.
- `.env.example`: add `UPWELL_GITHUB_REPO=Nath5/upwell` with a one-line description AND a security note: "GITHUB_TOKEN reused from the indexer carries `repo` scope (read access to private issues). Live skills query whatever repo this points to, so a meeting participant who speaks into the mic can indirectly read private issue state. Use a `public_repo`-scoped token instead if the target repo is public-only and you'd rather not allow private read-through."
- **Telemetry sanitization for live skills:** in serve.ts's `skill.start` event subscriber, special-case the 4 live-skill names. For those, replace `args.person` (if present) with `args.person.slice(0,3) + '...(' + args.person.length + ')'` before logging — keeps debuggability without writing the full spoken name to disk. `issue_number` is integer and logs verbatim. Corpus skills log args as today.

**Patterns to follow:**
- `apps/daemon/src/router/prompt.ts` — existing worked-example format and the `SkillName` references.
- `apps/daemon/src/cli/serve.ts` — existing classifier / relevance-classifier conditional registration pattern (env-key gated).
- `.env.example` — existing connector-token-style entries.

**Test scenarios:**
- Happy path (classifier extension): if testing classifier behavior end-to-end with fixtures, add 4 tests asserting the classifier returns the expected `skillName` for each new intent.
- Happy path (corpus skills unaffected): existing classifier tests for `github_count`, `github_list`, etc. still pass.
- Integration (env gating): when `UPWELL_GITHUB_REPO` is unset, the daemon starts with corpus skills only and logs the disable reason. Verified by reading serve.ts startup log lines.
- Test expectation for prompt-only changes: structural test only — assert the prompt builder output contains the new skill names. Behavioral classifier changes covered by U2/U3 tests at the skill layer (factory + handler).

**Verification:**
- All tests pass.
- `pnpm typecheck` clean.
- `pnpm test` includes 1+ test asserting the classifier prompt now includes references to the 4 new skill names.
- Manual: start the daemon with both env vars set → expect `github.live.enabled repo=... skills=4`. Unset either → expect the disable reason.

---

## System-Wide Impact

- **Interaction graph:** The skill registry is read by the router classifier and the pipeline's tool-execution branch. Adding 4 entries doesn't change either contract. Synthesizer treats live-skill results identically to corpus-skill results (both flow through `formatAsSource`).
- **Error propagation:** Skills throw `SkillExecutionError` on failure; the pipeline's existing `skillFailed` event handler logs the code and falls through to RAG-only (no synthesis with a tool source). User-visible failure mode is identical to existing skill failures.
- **State lifecycle risks:** None — skills are pure handlers, no persistent state, no caching.
- **API surface parity:** No public-facing API changes. Internal `LiveSkillContext` and `resolvePerson` are co-located with the skills.
- **Integration coverage:** The U4 manual verification (env gating + startup logs) covers the serve.ts → registry → classifier chain.
- **Unchanged invariants:** Corpus skills, classifier prompt structure (still cacheable), HUD WebSocket message types, synthesis flow.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| GitHub API endpoint changes (versioning) | `GithubClient` already pins `X-GitHub-Api-Version: 2022-11-28`. New skills inherit this. |
| Classifier picks wrong skill (e.g., `github_count` instead of `github_by_assignee_count` for "how many issues does nathan have") | Worked examples in U4 explicitly cover the disambiguation. Negative examples (the existing corpus-skill cases) anchor the classifier on those vs new skills. |
| Rate-limit exhaustion during heavy dogfood | 5000/hr is far above expected use. `GithubClient` already enforces a rate-limit floor warning. If hit, `RateLimitedError` propagates cleanly as a graceful refusal. |
| Person token doesn't match any GitHub user (e.g., misheard transcription) | `resolvePerson` returns null; skill returns "Couldn't find a GitHub user matching '<token>'." instead of failing or guessing. |
| Stale `UPWELL_GITHUB_REPO` (repo renamed / archived) | Endpoint returns 404 → mapped to `code: 'not-found'` → graceful refusal. User updates env. |
| Live-skill latency adds to meeting-response time | Each live skill is a single HTTP call (~100-500ms). The classifier itself adds ~500ms. Combined add ~1s on top of the embed+retrieve path — within acceptable bounds for a real-time meeting copilot. |
| **Token leakage via error message chain** | `GithubClient` already redacts the token in error message strings. U1's `mapGithubError` preserves the source message verbatim (no fresh string construction from raw API response), so redaction survives. U1 includes a token-non-leakage test asserting the chain end-to-end. |
| **URL path injection via spoken person token** | `resolvePerson` validates the token against `^[A-Za-z0-9_-]{1,39}$` (GitHub login charset) BEFORE any URL interpolation. Transcription artifacts, jokes, or malicious phrases with `/`, `..`, or whitespace are rejected at the resolver and return null — same outcome as "no user found." No API call fires. |
| **Search-qualifier injection via fallback path** | Resolved by the same upstream validation: only tokens matching the login charset reach the search fallback. By construction they cannot contain `:` or whitespace, so qualifier syntax (`org:victim`) is impossible. |
| **Indirect private-data exposure** | `GITHUB_TOKEN` carries `repo` scope which grants read access to private issues. Meeting participants can now indirectly query private GitHub data by speaking. Mitigation: `.env.example` includes a prominent warning explaining the attendee-mediated access model. Users with sensitive private repos can scope the token to `public_repo` instead — accepting that private issues simply won't surface through live skills. |
| **`skill.start` telemetry logs raw `args`** | `args` includes the literal `person` token from a spoken utterance — short personal names hit the log file unredacted. Mitigation (U4): for the new live skills, `skill.start` logs the args with the `person` field truncated to first 3 chars + length suffix (`person="nat...(6)"`) so debugging still works without writing the full name to disk. `issue_number` is integer and safe to log verbatim. |

---

## Documentation / Operational Notes

- Update `.env.example` with `UPWELL_GITHUB_REPO` documentation.
- Daemon startup log entries `github.live.enabled` / `github.live.disabled` are the visible signal that the feature is wired correctly.
- No README changes for v1 — internal feature.

---

## Sources & References

- **Origin document:** [docs/brainstorms/github-live-skills-requirements.md](../brainstorms/github-live-skills-requirements.md)
- **Related issue:** Multi-source classifier routing — https://github.com/Nath5/upwell/issues/17 (deferred work referenced in Scope Boundaries)
- Existing GitHub client: `apps/daemon/src/connectors/github/client.ts`
- Existing skill framework: `apps/daemon/src/skills/`
- Existing classifier prompt: `apps/daemon/src/router/prompt.ts`
- Prior plan (the router framework these skills extend): [docs/plans/2026-05-29-002-feat-router-skills-framework-plan.md](2026-05-29-002-feat-router-skills-framework-plan.md)
