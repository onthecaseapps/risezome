---
date: 2026-05-31
topic: live-page-synthesis-first
origin: docs/brainstorms/llm-synthesis-card-requirements.md
---

# Live Page: Synthesis-First with Quoted Citations

## Problem Frame

The live meeting page today is a 2-column grid: pinned + raw card stream on
the left, AI synthesis stream on the right. From hours of live testing the
verdict is clear — the raw cards are not what the user reads. The synthesis
is the value; the cards are noise the user has to mentally filter past.

This requirements doc reverses the original synthesis-card framing. The
prior brainstorm
(`docs/brainstorms/llm-synthesis-card-requirements.md`, D1) anchored on
"synthesis on top + raw cards underneath" with the explicit reasoning that
trust depends on visible provenance. That's still true, but provenance
doesn't have to mean "always-visible cards." Sources hidden behind a
one-click expansion — with the load-bearing portion highlighted on demand —
preserves verifiability without the scan cost.

The shift in product identity:

| Old frame | New frame |
| --- | --- |
| Synthesis is a lens over raw cards | Synthesis IS the surface; cards are evidence on demand |
| Trust through visible provenance | Trust through verifiable provenance |
| Raw cards persist as the source of truth | Cards exist only inside their parent synthesis |

The downstream consequences are explicit:

- A retrieval that doesn't result in a synthesis (because synthesis was
  refused, throttled, or errored) does not surface anywhere on the live
  page. The retrieval still writes to the DB; just no UI presence.
- Pinning moves from the card layer to the synthesis layer.
- A new responsibility lands on the LLM: emit not just the citation marker
  `[N]` but also the verbatim quote from source N that backs the surrounding
  claim.

This is what U-test ergonomics during the recent end-to-end live tests
strongly pointed toward. The change is significant but well-scoped to the
live page; review and captures pages are unaffected.

---

## Decisions

### D1. Output shape: Synthesis is the only primary surface

The live page renders a vertically-stacked, single-column feed of AI Summary
cards, newest below pinned, oldest at the bottom. The raw card stream is
removed entirely. The HUD-UI `CardStream`, the live page's left column, and
the standalone retrieval-driven card rendering all go away.

Cards continue to exist as DB rows (retrieval still writes them) and as
named slots inside a synthesis's `sources` array — but they have no
top-level UI presence on the live page.

*Considered and rejected:*
- **Keep cards, collapsed by default below the synthesis stream** — adds a
  second mental model ("there's a thing below I might want to open") for
  marginal benefit; we tested the existing stream and the answer was "don't
  bother showing them."
- **Hide cards but surface uncited retrievals as a side strip** — same
  problem in smaller form. If a retrieval was useful, it'd be cited.

### D2. Citations carry LLM-emitted verbatim quotes

The synthesis prompt is extended to require Claude to emit, alongside each
`[N]` citation, a short verbatim substring from source N that backs the
specific claim being cited. The synthesis storage layer carries this quote
per-citation so it can be re-rendered later from the review page or persist
across reconnects.

Clicking a citation chip `[N]` on the live page:

1. Locates source N within the synthesis's source list
2. Expands that source card inline below the synthesis (showing its body)
3. Substring-searches the source body for the quote, wraps the match in a
   highlight (`<mark>` or styled span)
4. Scrolls the highlighted span into view within the expanded card

Per-citation precision matters: the same source cited at two different
points in the answer (e.g., `[2]` at the start and `[2]` again later) can
highlight different lines in the same source.

*Considered and rejected:*
- **Heuristic client-side fuzzy match** — tokenize-and-overlap-score between
  the synthesis sentence and lines in the source. ~150 LoC, no backend
  changes, but failure modes are loud ("I clicked and it highlighted the
  wrong line" reads as buggy). For a real-time copilot, quiet beats wrong.
- **Embedding match chunk** — collapses to "highlight the whole card" since
  cards in this system already are chunks. No actual precision gain.
- **No highlight, just expand** — cheapest, but for multi-paragraph chunks
  (planning docs, long GitHub issues) the user still scans. The whole point
  of the change is to make the source instantly verifiable.

### D3. Pinning moves to the synthesis layer

The PinnedSection becomes a pinned-syntheses section. A new pin/unpin button
appears on each synthesis card; pinned syntheses stick to the top of the
page. The existing card-level pin/dismiss server actions remain in the
codebase (used by individual expanded source cards if/when we add card-level
actions back), but the top-of-page pinned UI tracks syntheses.

When a synthesis is pinned, expanded sources within it remain interactive —
clicking a citation still scrolls within the pinned card. Unpinning sends
the synthesis back to its chronological slot.

*Considered and rejected:*
- **Pin individual sources within a synthesis** — keeps pinning at the
  layer it lives at today, but a pinned source orphaned from its parent
  synthesis loses the context that made it interesting.
- **Drop pinning entirely for V1** — simplest, but pin/unpin is already
  shipped and meaningful for the "keep this on screen, I'll come back to
  it" workflow.

### D4. Streaming UX preserved

While the synthesis is streaming, the body shows the typing-cursor (existing
behavior). Citation chips render inert during streaming and become
interactive only when the stream completes (the parser runs once on `done`
to extract `[N: "..."]` citations + quotes).

Sources beneath the synthesis appear only when streaming completes (existing
behavior). The "Sources (N)" grid is replaced with the new expandable list.

> **Amendment (planning time):** An earlier draft of D4 specified per-chip
> mid-stream interactivity — chips going live as their quote token closed,
> with a "click-while-quote-still-streaming → expanded-on-arrival" fallback.
> Planning dropped that in favor of completion-time parsing (one parse pass
> on `done`, simpler parser state machine, ~3s synthesis latency makes
> mid-stream interactivity not worth the parser complexity). See plan U1+U2
> for the authoritative behavior.

### D5. Single column, full-width on the live page

The 2-column grid (`lg:grid-cols-[2fr_1fr]`) collapses to a single
centered column. Synthesis cards render at ~3xl max width so the line
length stays comfortable for the half-listening reader. Pinned syntheses
sit above; chronological newest-below-pinned beneath.

The header (meeting title, live indicator, minutes-in, channel status)
remains unchanged.

### D6. Synthesis placeholder card during the retrieval → first-token gap

With raw cards removed (D1), the gap between "retrieval just returned"
and "the first synthesis token streams in" — typically 500ms-1s while
the bot-worker issues the Anthropic call — becomes a dead zone on the
live page. Nothing new renders, even though work is happening. That's
a regression in perceived responsiveness vs. the old layout, where
raw cards appeared immediately at retrieval time.

The placeholder is a card that renders the moment the bot-worker
broadcasts `synthesisStart` (which fires before the first token, after
retrieval gating decides synthesis will run). It carries:

- A small "AI Summary" label matching the real card's label
- An animated skeleton (e.g., shimmering bars approximating one or two
  lines of text) so the user gets a "something's coming" signal
- A subtle "Searching your context…" or similar status line below the
  skeleton (copy is a polish-time decision)
- Optionally, the sources that retrieval already returned, listed by
  title only, so the user can see what's being synthesized over even
  before the answer arrives

When the first `synthesisDelta` arrives, the placeholder transitions
in-place into the real `SynthesisCard` (no flash, no separate mount):
the skeleton fades and the streaming text takes its position. The
existing typing-cursor takes over from there.

If `synthesisError` arrives before any text (rate limit, network, etc.),
the placeholder is removed silently. No error toast. Same quiet-failure
posture as today's refusal handling.

This decision intentionally does NOT extend to retrievals that won't
synthesize at all (refusals, gating below threshold, missing
ANTHROPIC_API_KEY). For those, no placeholder fires because there is
no `synthesisStart` broadcast. That keeps D1's "retrieval refusals
stay silent" invariant.

*Considered and rejected:*
- **Show a static "Synthesizing…" pill on the page header** — global
  status indicator, less informative than a per-synthesis placeholder.
  Doesn't tell the user *what* is being synthesized.
- **Block render until the first token arrives** — re-introduces the
  dead zone problem; the whole point is to fill that gap.
- **Show the raw cards transiently until synthesis streams in, then
  hide them** — conflicts with D1 and trains the user to scan cards
  for the half-second they're visible.

---

## Defaults

Decisions that didn't need to be hashed out but are committed for planning:

- **Quote storage.** The verbatim quote per citation is persisted with the
  synthesis (specific column vs JSON payload field is a planning-time
  decision). It must survive page reloads and be available to the review
  page.
- **Quote fallback when substring search misses.** If Claude paraphrases
  rather than quotes verbatim (the prompt asks for verbatim but is not
  100% reliable), the client falls back to expanding the source with no
  highlight. No error UI. The frontend never tries fuzzy matching as a
  fallback in V1 — quiet failure beats wrong-line highlighting.
- **Prompt cache invalidation cost.** Updating the synthesis system prefix
  to require quoted citations invalidates the cached 16K-token prefix once.
  TTFT and input-token cost briefly regress while the new prefix re-caches
  across meetings. Acceptable one-time cost.
- **Retrieval refusals stay silent.** When the synthesizer emits the
  `REFUSAL_SENTINEL`, nothing renders. This was already true; with cards
  gone, the consequence is just more visible.
- **Cards retain their pin/dismiss server actions** (`pinCardAction`,
  `dismissCardAction`) for use by expanded source cards later. The actions
  themselves stay; the top-of-page surface they fed gets replaced.
- **No card stream on review page in this unit.** The review page can keep
  its current shape; this work is scoped to the live page. A future unit
  can apply the same pattern to review if useful.

---

## Scope Boundaries

### In scope
- Live page (`apps/portal/app/(authed)/meetings/[meetingId]/live/`) rendered
  during the `recording` shell only
- Synthesis prompt rewrite to emit quoted citations
- Per-citation quote storage on `syntheses` (column or payload field)
- Synthesis streaming parser update to extract quotes
- New expandable source card UI in HUD-UI (`packages/hud-ui/src/components/`)
- New pinned-synthesis UI in HUD-UI
- Live page layout collapse (single column)
- Tests for quote extraction, expand/highlight behavior, pin/unpin

### Deferred for later
- **Fuzzy fallback for missed substring searches.** V1 fails quietly to
  no-highlight. A later unit can add a token-overlap fallback or instruct
  the LLM to retry with stricter quoting.
- **Multi-quote per citation.** V1 stores one quote per `[N]` occurrence.
  If a citation legitimately spans multiple disjoint spans of a source, V1
  picks one and lives with it.
- **Search/filter across past syntheses in a meeting.** As syntheses pile
  up over a long meeting the page becomes a long scroll. A search box,
  filter chips, or auto-collapse of older syntheses can come later.
- **Surfacing uncited retrievals.** Retrievals that didn't make it into a
  synthesis (refused, errored, throttled) don't show anywhere on the live
  page in V1. A future "Also found" or audit-trail view could surface
  them.
- **Highlight rendering inside markdown-formatted chunks** (code blocks,
  fenced syntax). V1 highlights plain-text substring matches; markdown
  rendering inside the source card may or may not exist at expand time,
  and exact-substring highlighting across markdown formatting is a known
  edge case to handle later.
- **Apply the same pattern to the review page.** Captures → review still
  uses the current card-and-synthesis layout. Migrating review can come
  after the live-page version proves out.

### Outside this product's identity
- Generative AI features that aren't grounded in retrieved sources (chat,
  follow-up questions answered without retrieval, summary-of-the-meeting).
  The synthesis is the lens over what we already retrieved; the product
  doesn't become a generic AI meeting assistant.

---

## Dependencies and Assumptions

- **Anthropic API** continues to be the synthesis provider. Quote-emission
  reliability depends on Claude's instruction-following; planning should
  budget for prompt iteration time.
- **Synthesis row schema** can absorb either a new column or a structured
  payload field for citations + quotes. Currently citations are stored as
  an array on the synthesis row — adding quotes is additive.
- **Streaming parser** in the bot-worker already extracts `[N]` tokens
  during synthesis streaming. It needs to extend to extract `[N:"..."]`
  (or whatever syntax the prompt settles on).
- **Pin/dismiss broadcast plumbing** at the synthesis level may not exist
  yet — today pin/dismiss is per-card. Planning needs to confirm whether
  synthesis pin state needs Realtime broadcast (cross-tab sync) or can be
  local-only for V1.

---

## Success Criteria

1. The live page during recording renders a single column of synthesis
   cards, with pinned syntheses pinned at the top and chronological
   newest-below-pinned beneath. No raw card stream is visible.
2. Clicking a citation chip `[N]` expands the corresponding source card
   inline and highlights the verbatim quote Claude emitted for that
   citation. The highlight is scrolled into view within the expanded card.
3. Per-citation precision: clicking `[2]` in one sentence vs `[2]` in
   another sentence of the same synthesis can highlight different parts of
   the same source.
4. Pin/unpin works at the synthesis level. Pinned syntheses persist their
   pinned state across page reloads and stay at the top.
5. Streaming UX is preserved: typing cursor while streaming, sources
   appear when streaming completes, citation chips become interactive as
   their quote becomes available.
6. When the LLM-emitted quote doesn't match a substring in the source body,
   the source still expands but no highlight is shown. No error UI.
7. End-to-end live-test sanity: a user in a real meeting with the bot
   joined sees synthesis cards arriving inline, can click a citation, sees
   the expanded source with the relevant line highlighted, and can pin a
   synthesis they want to keep visible.
8. The placeholder card appears within ~50ms of a synthesisStart event
   and transitions in-place into the real synthesis card on first
   streaming delta. No flash, no remount, no layout shift between the
   placeholder skeleton and the real text.

---

## Open Questions (deferred to planning)

- **Per-citation vs per-source quote storage shape.** If the synthesis
  cites source `[2]` three times, are there three separate quotes (one per
  citation occurrence) or one quote per source? Per-occurrence is more
  flexible; per-source is simpler. Planning should pick based on the
  schema choice.
- **Streaming vs completion-time quote parsing.** Do we parse quotes from
  the streamed text as they arrive (citation chip becomes live as soon as
  its quote closes), or only at completion (chip stays inert until
  streaming ends)? The user-facing latency difference is small (synthesis
  takes ~3s); planning should pick based on parser complexity.
- **Whether pinned-synthesis state needs Realtime broadcast.** If two
  org members have the live page open, does pinning on one tab reflect on
  the other? V1 default: per-tab local state (no broadcast). Planning
  should confirm.
- **Quote-emission prompt syntax.** Several options: `[2:"edition = 2021"]`,
  `[2]<quote>edition = 2021</quote>`, or a structured JSON output mode.
  Planning should pick based on streaming-parser ergonomics and Claude's
  reliability with each format.
