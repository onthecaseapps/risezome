---
date: 2026-05-29
topic: router-skills-framework
---

# Router + Per-Integration Skills Framework

## Problem Frame

Vector + BM25 retrieval is the right tool for "look up what X says" questions but the wrong tool for an entire class of questions a meeting copilot regularly hears:

- "How many open issues are there?"
- "List all PRs by jamie."
- "What was updated this week?"
- "Are there any Phase 2 issues we haven't shipped?"

These are **aggregation / structural** questions. The corpus has the data to answer them (issue state, labels, authors, updated_at are all in the docs), but retrieval is constitutionally unable to count, filter, or list-all. It pulls the top-K *most relevant* chunks and stops. When a user asks one of these questions, the current pipeline either refuses (sources don't address the utterance) or hallucinates a count from a sample of three.

This brainstorm introduces a second answer path that runs *alongside* retrieval: a router that classifies the utterance's intent and, when appropriate, dispatches to a per-integration **skill** — a typed, deterministic operation that queries the corpus structurally and returns a concrete answer. The classifier itself is a small Claude call gated by a fast regex so it only fires when the utterance shape suggests a tool-answerable question. Otherwise the existing RAG path runs unchanged.

The user's framing matters: the router becomes the framework that future integrations (Jira, Confluence, Slack, Snowflake) plug into. Each new connector ships not just an indexer but also a set of skills the classifier can invoke. This is the architecture that lets Upwell stay useful as the corpus grows beyond a few thousand chunks where naive RAG starts to thin out.

---

## Decisions

The brainstorm settled on the following anchor decisions.

### D1. v1 is strictly read-only

Skills query data. They do not create, modify, or send anything. No `create_issue`, no `merge_pr`, no `post_slack_message`. This is an identity constraint: stepping over the read-only line moves the product into "AI agent that takes actions" — a different, crowded category with much higher liability surface and a different user posture. Write-capable skills can be brainstormed as their own feature later, with their own consent model and UI affordances. For v1, every skill is a read.

### D2. Tool results render in the unified AI SUMMARY card

When a skill answers a question, its result is piped through the existing synthesizer as additional context. The synthesizer treats it as a numbered source (same format as a retrieved snippet) and cites it in natural language: *"The repo has 7 open issues, including #6 (post-meeting summary view) and #14 (confidence calibration). [1]"*. The user sees one answer surface, not two. The HUD has no new card type to learn.

*Considered and rejected:* a distinct STAT card type (forces users to mentally track two answer surfaces), tool result as a separate source row (technically works but signals "just another card" instead of a high-signal fact), per-skill rendering choice (premature abstraction; skills don't need presentation metadata yet).

### D3. Classifier runs heuristic-gated

A fast regex on the utterance's text classifies its shape locally: aggregation phrasings (`how many`, `count`, `list all`, `what's open`, `who has`, etc.) trigger the Claude classifier; everything else skips straight to retrieval as today. The common case (~80–90% of utterances) pays zero added latency and zero extra LLM cost. Only when the utterance shape genuinely suggests a tool-answerable question does the classifier spend its ~400 ms + ~$0.001.

*Considered and rejected:* classifier on every utterance (best routing accuracy but adds a uniform 400 ms tax that hurts the live-meeting feel), parallel-always (doubles cost regardless of which path is used), confidence-gated after RAG (misses cases where RAG happens to score well on the wrong shape of question).

### D4. v1 ships GitHub-only with 3–4 focused skills

The first cut covers the GitHub connector with four skills that clearly add value beyond RAG:

- `github.count(filter)` — counts docs matching a filter (state, labels, author, type)
- `github.list(filter, limit)` — returns up to N matching docs with title + url + state
- `github.recently_updated(days)` — returns docs updated in the last N days, sorted
- `github.by_author(login, filter?)` — returns docs authored or assigned to a login

Jira / Confluence / Linear skills are deferred to follow-up PRs once the registry shape is proven. The framework itself is general; the first set is intentionally narrow so we ship and dogfood it.

*Considered and rejected:* GitHub + Jira at once (Jira connector isn't built yet — would block on plan U13), count-only minimum (too thin to stress the registry abstraction), framework-only with no skills (no user-visible win, can't dogfood-validate).

### D5. Classifier and RAG run in parallel when the heuristic triggers

The moment the regex flags a utterance as tool-shaped, both the classifier call and the existing embed+retrieve pipeline kick off in parallel. Raw retrieval cards ship to the HUD as soon as they're ready (~600 ms) — the user never waits on the classifier just to see context. When the classifier returns, one of three things happens:

- **Tool decision:** the named skill executes against the corpus, its result joins the RAG snippets as numbered sources, the synthesizer runs.
- **RAG decision** (false alarm — heuristic flagged but Claude said "this is really a lookup question"): the synthesizer runs against the RAG snippets that already arrived. Optionally, the classifier returns an enhanced/HyDE-style rewritten query that the pipeline can use for a second-pass retrieval — but only as a v2 polish; v1 just uses the original retrieval.
- **Both:** classifier returns both a tool *and* RAG is useful. Tool result + RAG snippets both feed the synthesizer.

### D6. Tool failure falls back to RAG gracefully

When a skill execution fails (malformed args from the classifier, SQL error, connector unavailable), the synthesizer runs against the RAG snippets alone and the failure is logged as `synthesis.skill_failed` for telemetry. No user-visible error. No "the tool I tried didn't work" message. The user gets the existing experience, just without the tool boost they didn't know was being attempted.

### D7. Consent reuses the existing `anthropic` grant

The classifier call is an Anthropic call. The user already granted `anthropic` consent to enable the synthesizer. The classifier piggybacks on that grant; no new per-skill or per-connector grant is required. Skill execution itself does not call any third-party API beyond what the indexer already does — skills query the local SQLite corpus, not GitHub's live API — so no additional outbound surface to gate.

If a future skill genuinely needs live API access (e.g., "show me the *current* status of this PR" beyond the last index sweep), that skill will declare its outbound dependency and trigger the existing consent prompt for that provider. Deferred until needed.

---

## Defaults

Decisions that didn't need explicit hashing-out but are committed defaults for planning:

- **Privacy mode disables the classifier.** Matches the synthesis behavior — when privacy mode is on, the entire LLM surface is off, including classification. Heuristic regex still runs locally (no outbound), but the result is ignored. Pure RAG.
- **Tool result is numbered as the first source** when both tool result and RAG snippets exist. The synthesizer's existing citation convention (`[1]`, `[2]`, …) means the tool result becomes the most-prominent citation when it answers the question directly.
- **Skill registry is per-connector.** Each connector module declares its own skill set. The classifier's prompt is built by enumerating skills across all enabled connectors. v1 has only GitHub, so only GitHub skills appear.
- **Classifier prompt caching engages.** The skill registry + classifier instructions form the static prefix; the utterance is the dynamic body. The same cache-breakpoint pattern that synthesizer uses applies.
- **Telemetry parity with synthesis.** Every classifier call logs `classifier.start`, `classifier.done` (with `intent`, `confidence`, `latencyMs`, cache stats); every skill execution logs `skill.start` and `skill.done` (with name, args, result-shape, latencyMs). Feeds the same U24 stream as synthesis.

---

## Success Criteria

The feature is working when:

1. **Aggregation queries get correct answers.** "How many open issues are there?" returns the exact number, with the issues optionally enumerated by the synthesizer.
2. **The common case pays no tax.** Non-tool utterances run with no added latency, no extra LLM cost, identical TTFT to today's path.
3. **Tool-suspected utterances don't regress.** When the heuristic triggers but the classifier routes to RAG (false alarm), the user-visible behavior is identical to today plus ~400 ms of classifier latency (which runs in parallel with retrieval, so net latency overhead is near zero — bounded by `max(classifier, retrieval)`).
4. **Failure is invisible.** Classifier errors, skill execution errors, malformed args — none of them produce a user-visible error. All paths fall back to RAG synthesis cleanly.
5. **Cost per meeting stays bounded.** Typical 30-minute meeting (10–30 retrievals after debouncing) produces fewer than ~5 classifier calls (10–20% trigger rate × debounce). At Haiku pricing with caching engaged, +$0.005 / meeting versus today.
6. **The framework absorbs new connectors cleanly.** Adding a fifth skill to GitHub, or a first skill to Jira when its connector lands, requires no changes to the router itself — only registering the skill.

---

## Scope Boundaries

### In scope (v1)

- Heuristic regex for tool-shape detection
- Single Claude classifier call returning intent + skill name + args
- Per-connector skill registry with typed JSON-schema parameters
- Four GitHub skills: `count`, `list`, `recently_updated`, `by_author`
- Skill execution against the local SQLite corpus (no live API calls)
- Tool result piped to the synthesizer as a numbered source
- Telemetry log lines mirroring the synthesizer's pattern
- Privacy mode disables the classifier; pure RAG still works

### Deferred for later

- Additional connectors' skill sets (Jira, Confluence, Slack, Snowflake, Linear) — each adds its own skills against its own corpus
- Transcript enhancement / HyDE-style query rewriting on every utterance — the classifier's optional rewritten-query output is plumbed in v1 but the always-run-classifier mode is v2
- Tool-using Anthropic API (`tool_use` request shape with parallel tool calls) — the v1 classifier returns a *plan* the daemon executes, not native tool calls. Migration path is open.
- Cross-skill composition ("how many of jamie's open PRs are labeled bug" = by_author + by_label + count) — v1 supports single-skill calls. The classifier can pre-compose filters into one skill invocation if the skill's parameter schema admits it; the router doesn't chain skills.
- Live API queries (skills that need fresh data beyond the index sweep) — when a skill genuinely needs live data, that skill declares its own consent dependency and is gated separately.

### Outside this product's identity

- **Write-capable skills.** No `create_issue`, no `merge_pr`, no `comment_on_pr`, no `send_slack_message`, no `update_jira_ticket`. Upwell does not take actions on the user's behalf. It surfaces and synthesizes information. Write skills would change the product category and require an entirely different consent + confirmation + audit-trail surface. Out of scope for this brainstorm and not a follow-up.
- **General-purpose agent loop.** The classifier returns a single skill call per utterance, not a multi-step plan. No "let me try this, then that, then summarize" agentic chains. Each utterance is single-shot in/out, the same posture as the existing synthesizer.
- **Skill marketplace / user-authored skills.** v1 skills are first-party, declared in the connector modules. No plugin system, no user-uploaded JSON-schema-defined tools.

---

## Dependencies and Assumptions

- The existing `AnthropicSynthesizer` (recently shipped) provides the streaming Claude wiring. The classifier call reuses the same auth, headers, and prompt-caching shape — likely a sibling client (`AnthropicClassifier`) with its own prompt and response parsing.
- The existing consent module (`apps/daemon/src/cli/consent.ts`) gates the `anthropic` grant. No new provider to enumerate.
- The corpus SQLite schema already contains the fields skills need (`docs.type`, `docs.authors`, `docs.updated_at`, chunk text containing `Status: open` / `Labels: …`). No schema migration required for the v1 skill set.
- The retrieval pipeline (`apps/daemon/src/retrieve/pipeline.ts`) already runs embedding + hybridSearch on a debounced flush. The router insertion point is the same `#evaluate` seam where synthesis runs today.
- The HUD's existing `AI SUMMARY` card type handles streaming text + citation chips. No new card type is required.

---

## Open Questions for Planning

These are technical questions that planning will resolve, not product questions:

1. **Exact heuristic regex patterns.** What phrasings should trigger the classifier? Some are obvious (`how many`, `count`); others are judgement calls (`who has`, `is anyone`, `what's the status of all`). A starting set of ~10 patterns is a planning exercise. Test against transcripts.
2. **Classifier prompt template.** System prompt + few-shot examples that teach the classifier to pick a skill (or refuse → RAG) given the available registry. Likely 5–7 few-shots covering positive cases, refusal cases, and ambiguous cases.
3. **Skill registry shape.** Concrete TypeScript: probably `Skill = { source, name, description, paramsSchema, handler }`. JSON Schema for params so the classifier's JSON output can be validated before execution.
4. **Tool result formatting for the synthesizer.** When a `count` skill returns `7`, how is that formatted into the source-input string? `"GitHub count(state: open) → 7 issues"`? `"Tool result: 7 open issues"`? Affects citation style.
5. **Classifier response shape.** Free-form text vs. structured JSON. Anthropic supports both. v1 likely uses `tool_use` request format (structured) so we don't parse natural language back.
6. **Race semantics.** Classifier returns 400 ms after retrieval finishes — do we hold the synthesizer call until classifier returns, or fire it immediately on retrieval-done? Probably hold (small wait, big upside).
7. **Telemetry fields for skill choice quality.** What do we log so we can later evaluate "did the classifier pick the right skill?" Probably `classifier.intent`, `skill.executed`, `synthesis.cited_skill`.

---

## Sources & References

- This brainstorm extends the meeting context copilot established in `docs/brainstorms/meeting-context-copilot-requirements.md`.
- Synthesizer architecture (recently shipped) in `docs/plans/2026-05-29-001-feat-llm-synthesis-card-plan.md` — classifier reuses its auth, prompt-caching, and telemetry patterns.
- Chunker improvements (A–E) committed today already embed the status/labels/state metadata that v1 GitHub skills need to query structurally.
