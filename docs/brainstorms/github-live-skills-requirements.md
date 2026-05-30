---
date: 2026-05-29
topic: github-live-skills
---

# Live GitHub API Skills — Assignees + Issue Progress

## Problem Frame

The existing router/skills framework ships four GitHub skills that query the local SQLite corpus (`github_count`, `github_list`, `github_recently_updated`, `github_by_author`). They answer aggregation/list questions over **indexed** data. The corpus is only as fresh as the last `upwell index` run, and several common meeting questions need *current* state:

- "Who is issue 14 assigned to?"
- "What issues are assigned to nathan?"
- "How many issues does nathan have?"
- "Have we made progress on issue 14?"

Stale corpus data is wrong-answer-shaped for these — an issue that was unassigned at index time and got assigned an hour later would silently fail. The user has confirmed live API calls are within scope (still read-only).

---

## Decisions

### D1. "Progress on issue X" returns a timeline of recent activity

The classifier-selected `github_issue_progress` skill takes an issue number and returns:
- Current state (open / closed / merged)
- Current assignees + labels (for context, not as the primary answer)
- The last 3–5 events in chronological order: comments, label changes, assignee changes, state transitions, milestone changes

The synthesizer frames this as a short narrative: *"Issue 14 is open. Last week jamie added the `phase-2` label; two days ago nathan commented 'still blocked on the auth migration'; yesterday alice reassigned it to bob."*

*Considered and rejected:* state-only response (insufficient — "is it still open?" is rarely the actual question); binary verdict (shipped/blocked/in-review) — the heuristic for classification is brittle and the LLM synthesizer can derive it from the timeline anyway.

### D2. Person identification: try-as-login with GitHub user-search fallback

When the classifier extracts a name token from an utterance like "what issues are assigned to nathan":
1. First try the token as a literal GitHub login (`?assignee=nathan`)
2. If the response is empty or returns 404, call GitHub's user-search API (`GET /search/users?q=nathan in:name+in:fullname`) and pick the top match
3. Use the resolved login for the actual query

This handles the common "nathan" → "Nath5" disambiguation transparently. The cost is one extra API call on the fallback path, only when the literal token misses.

*Considered and rejected:* strict login-only (forces meeting users to know exact logins, fails silently otherwise); maintained alias map (cheap but requires keeping a list in sync — friction the user explicitly didn't ask for).

### D3. Env-configured single repo for v1

All four new skills target one repo configured via `UPWELL_GITHUB_REPO=owner/name`. The skills do not accept a `repo` argument in v1; the classifier doesn't need to extract one.

This fits the common case (one meeting, one project) without burning brainstorm effort on a much bigger architectural question — multi-source routing — that the user wants to address as its own future feature (see Deferred for later).

### D4. New skills are LIVE-API by default; corpus skills remain corpus-backed

`github_count`, `github_list`, `github_recently_updated`, `github_by_author` continue to query the local SQLite corpus. The four new skills hit the GitHub REST API at query time. The split is deliberate:

- **Corpus skills** answer aggregation/filter questions ("how many issues are open"). Fast (~0–1ms), no rate limit, but only as fresh as the last index. These are the everyday queries.
- **Live skills** answer person- and item-specific questions where freshness is the load-bearing signal ("is issue 14 still open?"). Pay ~100–500ms per API call + count against the user's GitHub rate limit.

The classifier picks per-utterance — there's no shared abstraction or fallthrough logic; the skills are sibling registry entries.

### D5. Authentication reuses the existing `GITHUB_TOKEN` env var

The same token the indexer uses (`apps/daemon/src/connectors/github/`). No new credential surface. If the token is missing, the live skills are disabled at registry-build time (parallel to how the synthesizer / router classifier disable when `ANTHROPIC_API_KEY` is absent).

---

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | A `github_issue_assignees` skill takes an issue number and returns the current list of assignees from the GitHub API. |
| R2 | A `github_by_assignee_list` skill takes a person token and returns the issues currently assigned to that person (resolved via D2). |
| R3 | A `github_by_assignee_count` skill takes a person token and returns a count of issues currently assigned to that person. |
| R4 | A `github_issue_progress` skill takes an issue number and returns the current state + assignees + labels + last 3–5 events in chronological order. |
| R5 | All four skills target the repo configured by `UPWELL_GITHUB_REPO`. If the env var is absent, the skills are not registered (logged at startup: `github.live.disabled reason=no-repo`). |
| R6 | Person identification (R2, R3) uses try-as-login + GitHub user-search fallback. The fallback fires only when the literal token returns no results. |
| R7 | The skills reuse `GITHUB_TOKEN` for auth. If missing, the live skills are not registered (logged: `github.live.disabled reason=no-token`). |
| R8 | API errors (rate-limit, network, 404, auth) propagate as `SkillExecutionError` and the synthesizer falls through to a refusal or generic response. The user sees a graceful "I couldn't reach GitHub right now" rather than a stack trace. |
| R9 | Per-skill telemetry follows the existing pattern: `skill.start`, `skill.done` with latency, `skill.failed` with error code. |
| R10 | The four new skills register alongside the existing four. The classifier prompt is extended with worked examples for each new intent so it can pick correctly. |

---

## Scope Boundaries

**In scope for v1:**
- Four new skills wired into the existing router/skills framework
- `UPWELL_GITHUB_REPO` env var as the single repo target
- Person-name fallback via GitHub user-search API
- Classifier prompt extension with worked examples
- Reuse of `GITHUB_TOKEN`

**Out of scope for v1:**
- Per-utterance repo extraction (multi-repo routing)
- Live API skills for any connector other than GitHub
- Caching API responses across utterances or meetings (single API call per skill invocation)
- Rate-limit-aware throttling beyond what the GitHub API client returns
- Webhook-driven real-time updates

### Deferred for later

- **Multi-source classifier routing** — when Confluence, Jira, Trello connectors land, the classifier needs to extract not just intent (count/list/detail) but **which source** the question is about. Today's classifier returns a single `skillName`; multi-source routing may need a richer return shape or a two-stage classification (source-then-intent). This is a meaningful brainstorm of its own — see future doc.
- **Multi-repo within GitHub** — same architectural shape as multi-source: the classifier extracts both intent and target repo. Same brainstorm.
- **Caching layer** — if dogfood shows the same issues being looked up multiple times per meeting, add a session-scoped TTL cache for API responses.

**Outside this product's identity:**
- Upwell remains read-only. These skills query GitHub but do not create issues, post comments, change assignees, or any other write operation. The read-only constraint is identity, not a v1 limitation.

---

## Dependencies / Assumptions

- `GITHUB_TOKEN` is already used by the indexer and present in `.env`. Reusing it is zero-friction.
- The GitHub REST API endpoints needed (issues, search/users, issue events, issue comments) are all on the standard 5000-req/hr rate limit with a token — sufficient for normal meeting volume.
- The existing skill contract (`apps/daemon/src/skills/contract.ts`) accommodates skills that don't need the corpus `db` (the `SkillContext.db` becomes unused for these skills; the contract doesn't enforce its use).
- The classifier's cacheable prompt (`apps/daemon/src/router/prompt.ts`) can absorb additional worked examples without breaking the 4096-token cache floor (it's already at ~4318 tokens; adding ~20 examples grows it but won't break it).
- The synthesizer's existing `formatAsSource(skillResult, name, args)` path handles `kind: 'detail'` results — the new skills' rich timeline output fits that shape.

---

## Success Criteria

Measured during dogfood after shipping:

1. "Who is issue 14 assigned to?" returns the current assignee within 1 second, even if the issue was reassigned after the last `upwell index` run.
2. "What issues are assigned to nathan?" returns the right list even when the user's GitHub login isn't exactly "nathan" (e.g., "Nath5").
3. "Have we made progress on issue 14?" surfaces the most recent activity, framed by the synthesizer as a 1–2 sentence narrative.
4. If `UPWELL_GITHUB_REPO` is absent, the daemon logs the disable reason at startup and the corpus-based skills continue to work unchanged.
5. A transient GitHub API failure (rate-limit, 5xx) is handled gracefully — the user sees a refusal or "I couldn't fetch that just now" rather than a crash or silent miss.

---

## Open Questions

These are intentionally left for planning:

- Exact GitHub API endpoint choice for `github_issue_progress` (`/issues/{num}` plus `/issues/{num}/events` plus `/issues/{num}/comments`, or `/issues/{num}/timeline` which combines them under a preview header).
- How many events to include in the timeline (3? 5?). 5 is the brainstorm anchor; planning may tune.
- Whether to expose the resolved login when the user-search fallback fires (e.g., "Resolved 'nathan' → 'Nath5'") — surfacing it builds user trust but adds prompt content.
- Whether the issue-number extraction is regex-based (in the classifier) or LLM-extracted (in the tool args). The existing router classifier handles arg extraction; this is more of a prompt-tuning question.
