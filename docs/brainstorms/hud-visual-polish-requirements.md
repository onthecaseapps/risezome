---
date: 2026-05-29
topic: hud-visual-polish
---

# HUD Visual Polish — v2 Visual Language

## Problem Frame

The HUD works but currently feels rough in two ways the user reports during dogfood:

1. **Cards arrive jarringly.** New `card` events render with no motion. When several land simultaneously (a typical retrieval flush emits up to 3 cards back-to-back) the result is a sudden visual change with no sense of arrival.
2. **Information is harder to find than it should be.** The visual hierarchy between title / snippet / metadata is uneven, source and type aren't visually distinguishable at a glance, the AI SUMMARY card visually blends with the raw source cards below it, and the `[N]` citation chips in synthesis text are decorative rather than actionable.

The product shape isn't changing. This is a polish pass that improves the perceived quality of an existing surface so the user trusts the HUD more during real meetings.

---

## Decisions

### D1. Card arrival: confident slide-down + fade

When a new card event arrives, the card mounts with:
- A vertical translate from a small upward offset (≈12–16px) to its resting position
- A fade from 0 → 1 opacity
- Total duration in the 200–250ms range
- Easing that decelerates into rest (an `ease-out` curve)

Because the stream is newest-first, the slide direction reads as the new card "dropping in from above" — natural for the existing scroll model. Existing cards reflow underneath via the same transition so the stream doesn't snap.

*Considered and rejected:* very subtle calm fade (under-communicates arrival when a single card lands amid silence); scale + bounce (too lively for a back-of-mind meeting copilot); highlight-only with no transform (loses the "something just happened" cue when the user isn't directly looking at the panel).

### D2. Stronger visual hierarchy

Cards get a clearer information rhythm:
- **Title** dominates as the entry point — heavier weight, slightly larger
- **Snippet** uses a comfortable line-height and a max line length so long lines don't sprawl edge-to-edge
- **Metadata** (source label, type, rank, timestamp) collapses to a quieter row beneath the title or beside it, smaller and lower contrast

The change is typographic, not structural — same content, easier to parse in a glance.

### D3. Colored source/type chips

Each card surfaces a small accent chip near the title indicating both *source* (GitHub, Slack, Jira, future) and *type* (issue, pull-request, code, doc). Different sources get distinct accent colors; types either get glyphs (issue dot, PR arrow, code brackets) or short text. The user instantly knows "that's a GitHub PR" or "that's a code chunk" without reading the metadata row.

Color choices must work in both light and dark themes and never be the sole signal (color-blind users still get the glyph or label).

### D4. Synthesis card visually distinct

The AI SUMMARY card no longer blends with the raw source cards below it. It gets:
- A clearly different visual treatment — accent border, subtle background tint, or both
- Slightly larger answer text so the answer reads as the answer, not as one more card
- Visual proximity / connection to its citing sources is preserved (so the user can follow the [N] references)

This makes "the answer" and "the supporting evidence" read as two distinct layers in the same stream.

### D5. Live citation chips

`[N]` chips in the synthesis text become interactive:
- Hovering shows a small preview tooltip of the matching source card's title
- Clicking scrolls to that source card and briefly highlights it (a soft pulse on the target card so the eye finds it)

The provenance feature stops being decorative.

---

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | Every new `card` event mounts with the D1 slide-down + fade animation (≈12–16px translate, fade 0→1, 200–250ms, ease-out). |
| R2 | When multiple cards arrive in the same flush, each animates independently — no Promise-coupled stagger is required, but cards should feel like they arrive together rather than queued. |
| R3 | The animation respects `prefers-reduced-motion: reduce` — under that media query, opacity-only fade (no transform). |
| R4 | The reflow of existing cards (being pushed down) shares the same transition curve so the stream doesn't visually snap. |
| R5 | Card titles use heavier weight + larger size than they do today. Snippet text uses a comfortable line-height and a max-line-length constraint. |
| R6 | Metadata row (source, type, rank, timestamp) drops to a smaller, lower-contrast presentation — visible but quiet. |
| R7 | Each card carries a chip near the title indicating both source and type. Source has an accent color; type has a glyph or short label. The same source produces the same accent color across cards. |
| R8 | Chip colors work in light and dark themes with sufficient contrast. Color is never the sole signal (glyph or label is always present). |
| R9 | The synthesis card has a visually distinct treatment from raw cards — accent border, background tint, or both — and uses slightly larger answer text. |
| R10 | The visual treatment for the synthesis card preserves the readability of the inline `[N]` citation chips. |
| R11 | `[N]` chips in synthesis text are interactive: hover shows a preview tooltip with the matching source card's title; click scrolls to and pulses the matching card. |
| R12 | If a citation `[N]` references a source that has since been retracted, the chip degrades gracefully (no broken interaction, no error). |
| R13 | All animations and transitions respect `prefers-reduced-motion: reduce` and disable transforms / large motion under that preference. |

---

## Scope Boundaries

**In scope for this pass:**
- Card arrival animation (D1)
- Typography + spacing hierarchy (D2)
- Source/type chips (D3)
- Synthesis card visual distinction (D4)
- Live citation chips with hover preview + click-to-scroll (D5)
- `prefers-reduced-motion` support for everything that animates

**Out of scope for this pass:**
- Card retraction / exit animation. Retractions are rare in practice; can add later if they feel jarring.
- Updating non-card UI (banners, theme toggle, empty state) beyond what's needed to harmonize with the new visual language.
- Density / layout-mode toggle (compact vs comfortable). The new spacing should be the right default.
- Adding new HUD surfaces (filter bar, search box, settings panel). Polish, not features.
- Per-source filter or hide controls.

**Outside this product's identity:**
- This is a polish pass, not a redesign. The HUD is a one-column stream of cards with an AI SUMMARY on top — that doesn't change. We are improving readability and rhythm, not introducing dashboards, sidebars, or multi-pane layouts.
- The HUD is a side-of-screen ambient surface during a meeting. Motion should support that — clearly noticed when you look, ignorable when you don't. No splashy, attention-demanding effects.

---

## Dependencies / Assumptions

- The HUD already uses Tailwind v4 (`apps/hud/src/styles.css`) with CSS-first config and `@custom-variant dark` for theming. New tokens for chip colors fit cleanly in that system.
- Existing animations (`pulse`, `synthesis-fade-in`, `synthesis-cursor-blink`, `empty-fade-in`) in `apps/hud/src/styles.css` set the precedent for `@keyframes` + `prefers-reduced-motion` support. New animations follow the same pattern.
- The sidebar render path lives in `apps/hud/src/sidebar.ts`. Card rendering, retraction, and synthesis updates all flow through methods on the `Sidebar` class. The animation hook lives there.
- The `CardEvent` payload already includes `source`, `type`, `rank`, and `surfacedAt`. Everything needed for D3's chip is present without daemon-side changes.
- Synthesis chunks already carry `synthesisId` and citation chips already render in `apps/hud/src/sidebar.ts`. Adding the hover preview + click-to-scroll affordance is a HUD-only change.

---

## Success Criteria

Measured during dogfood after shipping:

1. The user can describe the HUD as "feels polished" or equivalent without prompting.
2. New cards arriving during a quiet moment are noticed when looked at, and not noticed when ignored. No-one reports a flashy or chatty feel.
3. Source / type chips are readable in both light and dark mode without contrast issues.
4. Clicking a citation chip in the synthesis card reliably scrolls to and highlights the right source card.
5. With `prefers-reduced-motion: reduce` set in OS or browser, all animations degrade to opacity-only or instant changes; no transforms or large motion run.

---

## Open Questions

These are intentionally left for planning:

- Exact accent color palette for source chips and how it maps onto the existing Tailwind dark/light tokens.
- Whether the synthesis card's visual distinction is border-only, background-only, or both.
- Whether `[N]` hover preview is implemented as a CSS-only tooltip or a JS-driven floating element.
- Exact typographic scale (heading vs body sizes) and whether anything beyond title weight needs to change.
- Whether the cards' existing rank label ("Top match" / "Match") stays in the metadata row or moves into the source chip area.
