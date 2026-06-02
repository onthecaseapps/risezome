# Skills/RAG robustness — self-healing skills + router safety-net

Created: 2026-06-02

## Problem Frame

The meeting copilot routes each question to a structured **skill** (e.g. `github_count`) and/or **RAG** retrieval. The routing decision and the skill's argument extraction happen **up front, in one shot**, from raw meeting speech — and there's no recovery when that extraction is wrong. A skill fires, returns a result, and that result is prepended to synthesis as an authoritative source.

The failure mode this causes (observed live): *"How many open **case** GitHub issues do we have?"* → the classifier extracted `github_count { state:"open", labels:["case"] }` — over-reading the filler word "case" as a label. No such label exists, so the skill returned **0**, which the synthesizer stated as fact. A confidently-wrong answer is worse than no answer: in a glanced-at meeting copilot, the user won't catch a subtly wrong number.

The goal: skill answers that **survive messy real speech** — a mis-extracted argument must never produce a confidently-wrong answer — **without slowing the common (correct) path**, which is the overwhelming majority of questions.

## Who This Is For

The **meeting participant** who asks a question out loud and glances at the answer card. They speak naturally and imprecisely ("open case issues", company names and filler bleed into the phrasing), they cannot proofread the copilot's interpretation mid-meeting, and they will act on a wrong number if it looks authoritative. What changes for them: they can trust skill-backed answers because the system either gets the structured query right or visibly declines to assert a number it isn't sure of.

## Requirements

- **R1.** A mis-extracted skill argument must never yield a confidently-wrong answer. When an extracted argument doesn't exist in the skill's domain (a label/author/member/board that isn't real), the skill must neutralize it rather than silently filtering on it.
- **R2.** Recovery is **conditional and mostly deterministic**: the common path (correct extraction) adds no measurable latency or model cost. Only the rare misfire pays anything, and at most one extra step — no full agentic loop.
- **R3.** Skills expose a structured **recovery/confidence signal** on their result — e.g. "I dropped/neutralized argument X" or "low confidence" — so downstream consumers don't have to *infer* suspicion from a bare `0`.
- **R4.** The synthesizer consumes that signal and **never states a suspect or repaired result as hard fact**. It frames the answer honestly ("there's no 'case' label, so here are all the open issues…") and lets RAG context carry where the skill couldn't.
- **R5.** A **router-level safety-net** catches residual suspect/unrepairable results with **one** cheap conditional recovery step — retry with cleaned args, or fall back to RAG — firing only on misfires, never on the common path.
- **R6.** On a suspect-**but-repairable** result, **keep the repaired skill answer + RAG context**. Only fully drop the skill when the result is genuinely unrepairable.
- **R7.** A **genuine** empty/zero result (valid arguments, truly nothing matched) is still stated correctly as a fact ("0 open PRs"), and must be distinguishable from a misparse-zero.

## Key Decisions

- **KD1 — Two layers: self-healing skills (primary) + router safety-net (backstop).** Most misparses are "extracted a thing that doesn't exist," which a skill can validate against its own domain deterministically — in code, no model round-trip. The router net is the thin backstop for whatever slips through. (Both, per the brainstorm.)
- **KD2 — Offensive goal, cost-bounded.** Target the "actually get it right" outcome, not just defensive "don't be wrong" — but **without** the full agentic answerer; recovery is conditional and at most one extra step.
- **KD3 — Skills surface a structured repair/confidence signal** (R3) so the safety-net and synthesizer are principled, not heuristic guessers off a bare result.
- **KD4 — Keep the repaired skill result + RAG** on suspect-but-repairable (not RAG-only). Preserves useful structured answers; only unrepairable results drop the skill. (User choice.)
- **KD5 — No classifier-prompt whack-a-mole.** Rely on structural self-healing rather than patching the prompt per-phrase ("don't read 'case' as a label"). More durable — it neutralizes misparses we haven't seen yet. (User choice.)
- **KD6 — Distinguish misparse-zero from genuine-zero** via the validation: a `0` with a *valid* filter is genuine and stated as fact; a `0` with an *invalid* filter is a misparse and gets repaired/neutralized.

## Acceptance Examples

- **AE1 (the live failure).** "How many open case GitHub issues do we have?" → extracted `labels:["case"]`. The skill checks the repo's real labels, finds no "case", neutralizes the label, and returns the total open count + a repair note. Synthesized answer: *"There's no 'case' label — you have 12 open issues."* Not "0".
- **AE2 (valid arg).** "How many open bug issues?" → `labels:["bug"]` is a real label → the skill returns the real count, stated plainly as fact.
- **AE3 (genuine zero).** "How many open PRs?" with a valid filter that genuinely matches nothing → answered "0 open PRs" (correct — not treated as a misparse).
- **AE4 (unrepairable / skill error).** The skill errors or its result can't be salvaged → the router falls back to RAG; the answer comes from the corpus or an honest "I don't have that handy" — never a fabricated number.
- **AE5 (multi-arg).** "Open bugs assigned to someone who isn't on the team" → valid `state`/`label`, invalid `member` → neutralize only the bad arg, keep the rest, note the dropped filter.

## Scope Boundaries

### In scope
- A skill-result **recovery/confidence contract** (repair note + confidence signal) that synthesis and the router net consume.
- **Self-healing argument validation** for the current live skills (the GitHub + Trello family).
- The **router safety-net**: detect a still-suspect result, do one conditional recovery (retry cleaned / fall back to RAG).
- **Synthesis honesty**: don't assert suspect/repaired results as fact.

### Deferred for later
- Extending self-healing to future skills (Jira/Slack/Confluence) as those land — same contract, applied per skill.
- The **agentic answerer** (a bounded tool-use loop with RAG context that can compose multiple skills and self-correct over several rounds) — the north star if true composition becomes needed and the latency budget allows.

### Outside this product's identity
- Re-litigating **what should be a skill vs RAG** — the boundary stays as-is.
- Reworking the **classifier prompt for extensibility** as the source surface grows — that's the separate "routing manifest" thread (pending U7), not this.
- Per-phrase **classifier-prompt patching** for specific misparses (per KD5).

## Success Criteria

- No confidently-wrong skill answers from argument misparses across the eval set + dogfood (the "open case" class is gone).
- **Common-path latency and model cost are unchanged** — recovery only fires on misfires.
- Genuine results (including a genuine zero) are still stated correctly and confidently.
- Adding self-healing to a skill is a contained, repeatable change (one skill at a time), not a cross-cutting rewrite.

## Open Questions / Assumptions (resolve at planning)

- **Which arguments are "risky"** (free-text-ish: label, author, member, board name — extracted from speech) vs "safe" (closed enum: state, type) — this scopes where validation is needed.
- **The precise "suspect result" definition** the router net keys on (empty result + a repair signal + a risky arg).
- **Cost of the domain check** — e.g. listing a repo's labels to validate against. Assume it's cheap and/or cacheable per org so validation stays deterministic and adds no real latency; confirm during planning.

## Sources & Context

- Live failure: the "open case GitHub issues" → `labels:["case"]` → misleading `0` (this session's bot-worker logs).
- Current routing + skill execution: `apps/bot-worker/src/retrieval.ts` (classifier → tool/rag → skill → `toolSource` prepended to synthesis).
- Classifier: `packages/engine/src/router/` (heuristic gate + Anthropic classifier + few-shot prompt).
- Skill contract + formatting: `packages/engine/src/skills/contract.ts` (`SkillResult`, `formatAsSource`).
- Live skills (self-healing targets): `apps/bot-worker/src/skills/github/`, `apps/bot-worker/src/skills/trello/`.
- Synthesis prompt (honesty change): `packages/engine/src/synthesize/prompt.ts`.
