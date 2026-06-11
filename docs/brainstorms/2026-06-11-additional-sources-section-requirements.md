# Additional Sources on Synthesis Answers — Requirements

**Date:** 2026-06-11
**Status:** Brainstorm complete → ready for planning
**Tier:** Standard

## Problem

Synthesis answers are deliberately terse (1–3 sentences for a live HUD) and the
synthesizer cites only the sources its sentences actually draw on — usually the
top-ranked hit. When several retrieved sources corroborate the answer, the rest
are invisible: a live-mic trace showed "how do we contextualize each chunk and
how many lines do we use" answered and cited solely from the Confluence
`[RZ docs] architecture/retrieval-pipeline` page while the primary code sources
(`packages/engine/src/contextualize/`, `packages/engine/src/chunker/file-chunker.ts`
— which contains the literal line counts) were retrieved, ranked 2–3, and never
surfaced. The user can't see that the answer is corroborated, can't jump to the
primary source, and derived docs (which can drift from code) end up looking
like the only evidence.

The data already exists: every retrieved hit persists as a retrieval card and
the synthesis card carries the full retrieved set (`sourceCardIds`); citations
reference a subset by rank. This is an association + presentation gap, not a
retrieval gap.

## Goal

Keep answers terse and citations minimal, while surfacing the other retrieved
sources that genuinely support the answer as a compact, linked "Additional
sources" row beneath it — so corroboration and primary sources are one glance
away without bloating the synthesis.

## Decisions

- **Qualifier — model-marked supporting (chosen over "all uncited hits" and
  "score threshold"):** the synthesizer emits one optional protocol line (e.g.
  `ALSO: 2,3`) naming the uncited source ranks that also support its answer.
  Precise (a merely-adjacent hit like the trace's tree-sitter issue is not
  marked), costs no extra LLM call, and reuses the existing rank vocabulary.
- **Failure posture — never block the answer:** a missing or malformed `ALSO:`
  line means the section simply doesn't render. Marks are validated like
  citations: a rank must exist in the retrieved set and not already be cited;
  invalid marks are dropped silently.
- **Render everywhere the synthesis answer renders:** HUD live card, pinned
  syntheses, recap/review. Compact links row (source title → its existing URL);
  absent when nothing is marked.

## Requirements

- **R1** — The synthesis protocol gains an optional `ALSO:` line listing
  uncited-but-supporting retrieved source ranks; the prompt instructs the model
  to mark uncited sources only when they independently support the answer.
- **R2** — Marks are validated server-side: in-range rank, present in the
  retrieved set, not already cited; duplicates and invalid entries dropped.
  Validation failures never suppress or alter the answer itself.
- **R3** — The synthesis card payload carries the additional sources as
  references to their existing retrieval cards (no new retrieval, no new
  content storage).
- **R4** — Every surface that renders a synthesis answer renders an
  "Additional sources" row when present: title + link per source, visually
  subordinate to the answer and its citations.
- **R5** — Eval coverage: a golden multi-source question asserts that
  supporting-but-uncited sources are marked, and that an irrelevant retrieved
  hit is not.

## Scope boundaries

**Out of scope:**
- Changing citation behavior, answer length, or the grounded-or-nothing rules.
- Re-ranking, re-retrieving, or fetching anything new for the section.
- Clickthrough analytics on the links.

## Success criteria

- The motivating trace case renders: Confluence-cited answer with
  `contextualize.ts` and `file-chunker.ts` linked beneath; the tree-sitter
  issue absent.
- No regression in eval pass rate / precision; answers stay 1–3 sentences.
- A garbled `ALSO:` line in synthesis output produces a normal answer with no
  additional-sources row (verified by test).

## Open questions for planning

- Exact protocol placement (line after the answer body vs. after STATUS) and
  parser shape, mirroring how citations are parsed today.
- Whether the live HUD row shows titles or favicon-style source-kind chips at
  small sizes.
