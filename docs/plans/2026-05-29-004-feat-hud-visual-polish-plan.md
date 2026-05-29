---
title: "feat: HUD visual polish — v2 visual language"
type: feat
status: active
date: 2026-05-29
origin: docs/brainstorms/hud-visual-polish-requirements.md
---

# feat: HUD Visual Polish — v2 Visual Language

## Overview

Five coordinated polish improvements to the HUD that together form a new visual language: card arrival motion, typography hierarchy, source/type chips, distinct synthesis treatment, and live citation chips. HUD-only — no daemon changes. Each unit can land independently; together they materially change how the HUD reads during a meeting.

---

## Problem Frame

The HUD currently works but feels rough in dogfood. Two anchor pain points (see origin):

1. **Cards pop in jarringly.** No motion on `card` event; multiple cards landing back-to-back is visually startling.
2. **Information is harder to find than it should be.** Hierarchy is uneven, source/type isn't visually distinguishable at a glance, the AI SUMMARY blends with raw cards below it, and `[N]` citation chips are decorative.

This plan is a polish pass that improves perceived quality of an established surface — the product shape (one-column stream with AI SUMMARY on top) doesn't change.

---

## Requirements Trace

- R1. Every new `card` event mounts with slide-down + fade animation (≈12–16px translate, fade 0→1, 200–250ms, ease-out).
- R2. Multiple-card-per-flush case feels like cards "arrive together," no Promise-coupled stagger required.
- R3. Animation respects `prefers-reduced-motion: reduce` → opacity-only fade, no transform.
- R4. Reflow of existing cards (pushed down) shares the same transition curve.
- R5. Title weight + size dominate; snippet uses comfortable line-height + max line length.
- R6. Metadata row drops to smaller, lower-contrast presentation.
- R7. Each card carries a chip near the title indicating source AND type; source has an accent color, type has a glyph or short label.
- R8. Chip colors work in both light/dark themes with sufficient contrast; color is never the sole signal.
- R9. Synthesis card has a visually distinct treatment (accent border, subtle background tint, or both) and uses slightly larger answer text.
- R10. Synthesis card treatment preserves readability of inline `[N]` citation chips.
- R11. `[N]` chips interactive: hover shows title preview, click scrolls to + pulses the matching source card.
- R12. If a citation references a retracted source, chip degrades gracefully (no error, no broken interaction; explicit muted styling per U5).
- R13. All animations/transitions respect `prefers-reduced-motion: reduce`. (Cross-cutting; primary mechanism in U1's property-targeted media query block, inherited by U5's `cite-pulse`.)

**Implicit requirements added during plan review:**

- R14. Citation chips meet WCAG 2.1 SC 2.1.1 (Keyboard) and SC 2.4.7 (Focus Visible) — interactive via keyboard with a visible focus ring (covered by U5).
- R15. Chip text contrast is ≥ 4.5:1 against BOTH the raw-card background AND the U4 synthesis tinted background, in BOTH themes (covered by U3 + U4).
- R16. The reduced-motion mechanism does NOT erase non-motion transitions (e.g., card-update border-color flash, button hover transitions) and does NOT halt the `.status-live::before` connection indicator pulse (covered by U1 property-targeted approach).

---

## Scope Boundaries

- No card retraction/exit animation (deferred — retractions are rare in practice; revisit if they feel jarring).
- No non-card UI changes beyond what's needed to harmonize (header banner, theme toggle, empty state stay as-is).
- No density / layout-mode toggle (the new spacing IS the default).
- No new HUD surfaces (filter bar, search box, settings panel) — polish, not features.
- No per-source filter or hide controls.
- No redesign — same one-column stream with AI SUMMARY on top. Different look, same shape (carried from origin's "Outside this product's identity").

---

## Context & Research

### Relevant Code and Patterns

- `apps/hud/src/sidebar.ts` — `Sidebar` class. `renderCard()` prepends to `#streamEl.firstChild`. `renderSynthesisStart()` does the same. `removeSynthesis()` and `retractCard()` handle removal. Citation chips are rendered in synthesis-text processing inside this file.
- `apps/hud/src/styles.css` — Tailwind v4 with CSS-first config and `@custom-variant dark`. Existing keyframes: `pulse` (drives `.status-live::before` connection indicator, NOT the new-content-badge), `synthesis-fade-in` (already applied to `.card.synthesis` as an always-on entry animation), `synthesis-cursor-blink`, `empty-fade-in`. Existing transitions on `.card { transition: background 200ms ease, border-color 200ms ease }` and on title links, buttons, chips. No `prefers-reduced-motion` block today — the new work establishes that pattern.
- `apps/hud/src/sidebar.ts` already wires `data-card-id` on each card root (line 483), already renders `.citation-chip` spans with click → `document.querySelector('[data-card-id=...]').scrollIntoView({ behavior: 'smooth', block: 'center' })` (lines 467–474). Click-to-scroll already works and is tested at `apps/hud/test/sidebar.test.ts:236–249`. U5's new work is layered on top of this, NOT greenfield.
- `apps/hud/src/styles.css:374–375` — `.card.synthesis` already has `border-left-width: 3px; border-color: var(--accent); animation: synthesis-fade-in 220ms ease-out`. U4 must NOT re-add the border; U1 must reconcile the always-on `synthesis-fade-in` with the `is-entering` class pattern (see U1 Approach).
- `apps/hud/src/main.ts` — bootstrap entry, `applyInitialTheme()` toggles `.dark` on `<html>`. New tokens for chip accents go in `styles.css` and use the same `:root` / `:root.dark` pattern as existing tokens.
- `apps/hud/src/icons.ts` — Font Awesome SVG renderer. Source for chip glyphs (already supports `renderIcon(doc, name, opts)`).
- `apps/hud/test/sidebar.test.ts` — 62 tests covering card rendering, retraction, synthesis lifecycle, citation chips. Test infrastructure handles DOM injection via `jsdom`.

### Institutional Learnings

- Recent learning embedded in this session: the HUD's `synthesisDone` text-cleaning pass (in `apps/hud/src/sidebar.ts`) strips invalid `[N]` tokens whose `N` is not in the citation set. Live citation chips need to keep working through that cleaning — the regex that finds chips for interactive binding should match what's left after cleaning, not before.
- The empty-state placeholder rotates with em-dash scrubbing. Visual changes here should respect that rotation cadence rather than fighting it.

### External References

None needed. Tailwind v4 docs / CSS animation patterns are well known and the local code shows direct precedent.

---

## Key Technical Decisions

- **Animation lives on the card element via a class added at insert.** Each new `.card` element starts with `is-entering`; class removal is **belt-and-suspenders**: an `animationend` listener AND a `setTimeout` slightly longer than the animation duration (≈400ms for a 220ms animation). The setTimeout matters because under `prefers-reduced-motion: reduce` the animation may not run at all (or runs with `animation-duration: 0.01ms`), and `animationend` fires unreliably in backgrounded/occluded tabs.
- **Sibling reflow is NOT smoothly animated in v1.** The native CSS `transition: transform` does not animate layout-driven position changes from `insertBefore` — that requires the FLIP technique (measure-flip-invert-play), which is out of scope for a polish pass. Existing cards snap to their new positions; the entering card's downward motion masks the shift visually. If snap proves jarring in dogfood, FLIP becomes a v2 unit.
- **Synthesis card animation reconciled with `is-entering`.** The existing always-on `.card.synthesis { animation: synthesis-fade-in 220ms ease-out }` is **removed** as part of U1. Both raw cards and synthesis cards mount with `is-entering` → `card-enter` keyframe; the synthesis card's distinct *resting* state (U4) is unchanged. Without this removal, the synthesis card would double-animate or override.
- **`prefers-reduced-motion` is implemented with property-targeted rules**, NOT a `* { animation: none !important }` blanket. The block sets `animation-duration: 0.01ms !important` and `transition-duration: 0.01ms !important` on `*` — this lets opacity portions of existing keyframes still apply (at near-instant duration) without erasing non-motion transitions like `.card`'s `transition: background ... border-color ...`. The `.status-live::before` infinite pulse is explicitly re-enabled inside the reduced-motion block (it's a connection-down signal that reduced-motion users still need); a small comment explains why.
- **Source accent colors are CSS variables, treated as internal-convention palette, NOT brand colors.** A single map: `--src-github`, `--src-jira`, `--src-slack`, `--src-code`, `--src-default`. The map has separate light/dark values via `:root` / `:root.dark`. Brand-mimicking colors actively confuse users (GitHub isn't purple, Slack isn't green, Jira's brand blue isn't `#2563EB`) — so the palette is chosen for **visual distinguishability and contrast**, not brand fidelity. Document this intent in a `styles.css` comment so future contributors don't "fix" them to brand. The glyph is the brand signal; the color is just discrimination.
- **Type glyphs require adding four Font Awesome icons.** `apps/hud/src/icons.ts` currently exports only `sun, moon, thumbtack, bookmark, xmark, externalLink`. U3 must add deep-path imports for `faCircleDot`, `faCodePullRequest`, `faCode`, `faFileLines`, extend the `Icons` record AND the `IconName` string-literal union, and verify the imports tree-shake from the installed FA version. The plan's earlier "add if missing" framing understated this — all four are missing today.
- **Synthesis distinction is tint + larger answer text, NOT a re-added border.** The left accent border already exists at `apps/hud/src/styles.css:374` (`border-left-width: 3px; border-color: var(--accent)`). U4's new work is the subtle tinted background, the slightly larger answer text, the `data-kind="synthesis"` attribute, and contrast revalidation of citation chips against the new tint. Do NOT re-add the border.
- **Citation hover preview uses native `title` attribute on the existing `.citation-chip` span.** Click-to-scroll already exists at `apps/hud/src/sidebar.ts:467–474` against the existing `data-card-id` attribute (NOT a new `data-source-card-id`). U5's new work is: populate `title` with the source card's title text during chip render, add a `cite-pulse` keyframe + `is-cited-target` class around `scrollIntoView`, handle the retracted-source case explicitly, and add keyboard accessibility (see next item).
- **Citation chips become keyboard-accessible.** Currently rendered as `<span class="citation-chip">`. U5 changes the element to `<button type="button" class="citation-chip">` (or adds `role="button"` + `tabindex="0"` to the span). Enter and Space trigger the same scroll + pulse as click. A visible focus ring is required (a 2px outline using `var(--accent)`, visible against both the raw-card background and the U4 synthesis tint). This isn't aesthetic — it's WCAG 2.1 SC 2.1.1 (Keyboard) and SC 2.4.7 (Focus Visible) compliance.
- **Target-card "pulse" is a NEW `cite-pulse` keyframe**, not reuse of `pulse`. The existing `pulse` keyframe (`0%,100% { opacity: 1 } 50% { opacity: 0.35 }`) is an opacity dim, not a visible glow — reusing it would produce a subtle one-cycle dim that fails the "draw the eye" UX intent. New `cite-pulse` does a one-shot 600ms `box-shadow` ring expand + border-color flash; uses `forwards` so the card returns cleanly to rest.
- **`is-cited-target` cleanup uses setTimeout, not animationend.** Same reasoning as `is-entering`: animationend doesn't fire under reduced-motion when animations are suppressed.
- **Chip contrast target is 4.5:1 WCAG AA.** Chip text is small (≈11px); 4.5:1 is the strict body-text threshold. The 8–12% accent tint background is decorative; the text color is the load-bearing signal and must hit 4.5:1 against BOTH the raw-card background AND the U4 synthesis tinted background in both themes. Validate during implementation.
- **Type chip glyph is accessible via `aria-label` on the glyph wrapper**, not `title` on a `<span>`. `<span role="img" aria-label="Pull request">…glyph SVG…</span>`. `title` on non-interactive spans is not reliably announced by screen readers.

---

## Open Questions

### Resolved During Planning

- *Where does animation live?* On each card element, via a class added at insertion time, removed on `animationend`. See Key Technical Decisions.
- *How is `prefers-reduced-motion` honored?* Single media query block in `styles.css` collapses all transforms / keyframes to instant or fade-only.
- *Are accent colors hardcoded or tokenized?* CSS variables with light/dark variants in `:root` / `:root.dark`.
- *What glyphs?* Existing Font Awesome icons via `apps/hud/src/icons.ts`.
- *Is synthesis bigger or just styled differently?* Same width, accent border + tint + slightly larger answer text only.
- *CSS tooltip or JS popover for citation hover?* CSS tooltip in v1; revisit if too constrained.

### Deferred to Implementation

- Exact translate distance in pixels (12 vs 14 vs 16) — pick during implementation when you can see the motion live and adjust.
- Exact accent color hex values per source (internal-convention palette, NOT brand) — pick from Tailwind hues against the existing dark/light palette; document choice + non-brand intent in `styles.css` comments.
- Exact synthesis tint opacity — tune against live HUD; both modes need to read as "this is the answer" without being garish.
- Whether the citation chip tooltip needs a delay (no-delay can feel chatty when scanning).
- Exact `cite-pulse` keyframe shape — `box-shadow` ring expand vs border-color flash vs combination; pick from live preview.

---

## Implementation Units

- [x] U1. **Card arrival animation + reflow + global reduced-motion guard**

**Goal:** New cards mount with a confident slide-down + fade. Existing cards being pushed down reflow smoothly. Reduced-motion users see opacity-only fade.

**Requirements:** R1, R2, R3, R4, R13

**Dependencies:** None

**Files:**
- Modify: `apps/hud/src/sidebar.ts` — add `is-entering` class on insert in `renderCard()` AND `renderSynthesisStart()`; remove via `animationend` AND a `setTimeout(400ms)` safety net (idempotent classList.remove)
- Modify: `apps/hud/src/styles.css` — `@keyframes card-enter` + `.card.is-entering { animation: card-enter 220ms cubic-bezier(0.16, 1, 0.3, 1) both; }`; **remove** the existing always-on `animation: synthesis-fade-in 220ms ease-out` from `.card.synthesis` (line 375) — synthesis card now uses the same `card-enter` via `is-entering`; add global `@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } .status-live::before { animation: pulse 1.6s ease-in-out infinite !important; } }` (connection-status pulse re-enabled because it's a connection-down signal, not decorative motion)
- Test: `apps/hud/test/sidebar.test.ts` — extend with rendering assertions

**Approach:**
- Inside `renderCard()`, immediately after `insertBefore`, add `is-entering`. Bind a one-shot `animationend` listener AND a `setTimeout` that both classList.remove (whichever fires first wins, both are idempotent).
- Same treatment in `renderSynthesisStart()` — both raw and synthesis cards share `is-entering` motion language.
- **No smooth sibling reflow in v1.** Existing cards being pushed down snap to their new positions; the entering card's downward motion masks the shift. Document this in 'Considered and rejected' for U1.
- The reduced-motion block uses **property-targeted** rules (`animation-duration` and `transition-duration` near-zero), NOT `animation: none`. This keeps the opacity portions of existing keyframes available (at near-instant duration) and preserves non-motion transitions like `.card { transition: background ... }`. The `.status-live::before` infinite pulse is explicitly re-enabled inside the reduced-motion block.

**Considered and rejected:**
- *Smooth sibling reflow via `transition: transform 200ms ease-out` on `.card`.* `insertBefore` is a layout-driven change, not a transform-driven one; the CSS transition would be a no-op without a FLIP wrapper (measure-flip-invert-play). Adding FLIP is out of scope for a polish pass. Cards snap; revisit in v2 if dogfood shows the snap is jarring.
- *Blanket `* { animation: none !important; transition: opacity 120ms ease !important }` for reduced-motion.* Erases existing non-motion transitions (button hover border-color, card update flash) and stops the `.status-live` pulse which is a connection-down signal a reduced-motion user still needs. Replaced with property-targeted rules above.
- *Reusing the existing `synthesis-fade-in` keyframe on the synthesis card.* Would conflict with the shared `card-enter` via `is-entering`. The keyframe is removed; the synthesis card's resting visual distinction (U4) remains.

**Patterns to follow:**
- Existing `synthesis-fade-in` keyframe (in `apps/hud/src/styles.css`) — same fade-up shape, just slightly shorter and more vertical travel. Use as a starting point, then REMOVE the always-on application on `.card.synthesis`.
- Existing class-removal-after-timeout pattern at `apps/hud/src/sidebar.ts` `updateCard` (≈line 226): `setTimeout(() => rec.el.classList.remove('updated'), 250)`. **Note:** there is no existing `animationend` listener in `sidebar.ts`; the plan introduces the pattern. `setTimeout` is the local idiom and is also resilient under reduced-motion (animationend may never fire if animations are suppressed).
- Test environment is **happy-dom** (see `// @vitest-environment happy-dom` at the top of `apps/hud/test/sidebar.test.ts`). NOT jsdom.

**Test scenarios:**
- Happy path: `renderCard(card)` adds `is-entering` to the new card element; after dispatching `animationend` the class is removed.
- Happy path: `renderSynthesisStart()` produces a synthesis card with the same `is-entering` class.
- Edge case: `setTimeout` safety net — `vi.useFakeTimers()`; render a card, do NOT dispatch `animationend`; advance time past 400ms; assert `is-entering` is removed by the timeout path.
- Edge case: idempotent removal — fire BOTH `animationend` and the timeout; the class is removed exactly once and no error is thrown.
- Edge case: Two `renderCard` calls in quick succession — both new cards get `is-entering`; the previously-rendered card does NOT have `is-entering` (it would replay otherwise).
- Edge case: After cleanup fires, calling `renderCard()` with a new event does not retrigger entry on the old card.
- Verification: a string-check on `styles.css` for the `@media (prefers-reduced-motion: reduce)` block is a **structural smoke test, not a behavioral test.** True verification of reduced-motion behavior is **manual** (see Verification below).

**Verification:**
- All test scenarios pass.
- `pnpm typecheck` clean.
- **Manual (required before merge):** in a real browser, new cards visibly slide-down + fade in ~220ms. In DevTools "Emulate CSS prefers-reduced-motion: reduce": new cards appear near-instantly, AND the `.status-live` connection indicator continues pulsing (it's deliberately re-enabled). Card-update flashes (`.card.updated` border-color transition) AND button hover transitions still work under reduced-motion (the property-targeted rule doesn't erase them).

---

- [x] U2. **Typography hierarchy + spacing rhythm**

**Goal:** Card title dominates as entry point; snippet has a comfortable rhythm; metadata recedes. Same content, easier to parse.

**Requirements:** R5, R6

**Dependencies:** None (independent of U1; can land first if preferred)

**Files:**
- Modify: `apps/hud/src/styles.css` — `.card-title` weight/size, `.card-snippet` line-height + `max-width`, `.card-meta` size/contrast
- Modify: `apps/hud/src/sidebar.ts` — class additions on existing render-output structure if any element doesn't have the right class yet
- Test: `apps/hud/test/sidebar.test.ts` — structural assertions on class names

**Approach:**
- Increase title size by ~10–15% and bump weight from 600 to 700; tighten line-height for the title itself.
- Snippet gets `line-height: 1.55` and `max-width: 65ch` (or equivalent in container terms). Long URLs / code lines still scroll horizontally where they did before — the max-width applies to prose only.
- Metadata row shrinks one step (e.g., `text-xs`) and uses `var(--muted)` instead of body color.
- Spacing rhythm: standardize card-internal padding to a consistent vertical scale (e.g., 12px top / 8px between blocks / 12px bottom) so the eye finds the rhythm.

**Patterns to follow:**
- Existing Tailwind v4 token usage in `styles.css` (CSS variables for color, classes for layout).
- Existing `.card` shell styles — extend, don't replace.

**Test scenarios:**
- Happy path: rendered card has elements with classes `card-title`, `card-snippet`, `card-meta` (or equivalent — assert on whichever convention the implementation settles on; the test pins the contract).
- Test expectation: visual-only properties (font-size, line-height, max-width) — assert via structural class presence, not computed-style, since jsdom doesn't compute CSS.

**Verification:**
- All test scenarios pass.
- Manual review: in a real browser, the title visibly dominates, snippet reads at a comfortable rhythm, metadata is present but quiet. Take a screenshot before/after for the PR description.

---

- [x] U3. **Source/type chips with accent colors + glyphs**

**Goal:** Each card surfaces a small chip near the title showing source (color-accented) AND type (glyph). User instantly knows "GitHub PR" or "code chunk" without reading.

**Requirements:** R7, R8

**Dependencies:** U2 (typography baseline) — recommended order, not strictly required.

**Files:**
- Modify: `apps/hud/src/sidebar.ts` — chip render helper; called inside `renderCard()` to insert the chip near the title
- Modify: `apps/hud/src/styles.css` — `.chip-source`, `.chip-type`, `--src-github`, `--src-jira`, `--src-slack`, `--src-code`, `--src-default` tokens (light/dark variants), contrast-safe text color (4.5:1 WCAG AA against BOTH raw card AND U4 synthesis tinted background)
- Modify: `apps/hud/src/icons.ts` — **add four icons** (none currently exported): deep-path imports for `faCircleDot`, `faCodePullRequest`, `faCode`, `faFileLines`; extend the `Icons` Record AND the `IconName` string-literal union. Verify the deep-path import names against the installed `@fortawesome/free-solid-svg-icons` version (FA5 vs FA6 naming differs)
- Test: `apps/hud/test/sidebar.test.ts` — chip presence, source-color mapping, glyph for each type, aria-label on glyph wrappers

**Approach:**
- Chip shape: small inline pill, 2–3px vertical padding, 6–8px horizontal, rounded full. Source-color background tint (8–12% accent) is **decorative**; chip TEXT carries the load-bearing signal at 4.5:1 contrast.
- Type chip is a glyph wrapper with `<span role="img" aria-label="Pull request">…SVG…</span>`. `aria-label` is the screen-reader signal; `title` is supplemental. NOT `title` on a non-interactive span — that's unreliable across NVDA/JAWS/VoiceOver.
- Source-to-color map and type-to-glyph map are exported from `sidebar.ts` (or a sibling module) so tests can assert.
- **Colors are internal-convention palette, NOT brand colors.** Implementer picks indicative hues from the Tailwind palette (e.g., violet-500, blue-500, emerald-500, orange-500, gray-500) tuned for distinguishability and contrast in both themes. A comment in `styles.css` explains the choice so future contributors don't "fix" them to brand. Brand-mimicking colors confuse users — GitHub isn't purple, Slack isn't green, Jira's blue isn't `#2563EB`.
- Chip ceiling is documented: the model works for ~5 named sources + default. New sources beyond that either get added to the palette or fall back to `--src-default` (glyph + label remain the signal). v2 may revisit with a hue-rotation scheme if connectors multiply.

**Patterns to follow:**
- Existing icon rendering in `sidebar.ts` via `renderIcon(doc, name, opts)` — the chip helper uses the same shape.
- CSS variable + `:root.dark` pattern for theme-aware colors.

**Test scenarios:**
- Happy path: a GitHub-source `card` event renders with a chip whose computed source-class is `chip-source-github`.
- Happy path: a card with `type: 'pull-request'` renders a chip whose glyph wrapper has `aria-label="Pull request"` and contains the `code-pull-request` SVG (assert via `data-glyph` attribute or icon-name string).
- Edge case: an unknown source falls back to `chip-source-default`; an unknown type falls back to a generic icon (or omits the type chip with no error).
- Edge case: chip text is short and doesn't overflow when the title is long.
- A11y: type chip's wrapper has `role="img"` AND `aria-label` matching the expected human-readable type name.
- Integration: dark mode toggle — chip source colors switch to their dark-mode token. Verify via class-presence assertion since computed-style is unreliable in happy-dom.

**Verification:**
- All test scenarios pass.
- **Manual review (required before merge):** chip TEXT contrast is ≥ 4.5:1 against the raw card background AND against the U4 synthesis tinted background, in BOTH themes. Screenshot the contrast-check matrix in the PR description. Glyphs read correctly via keyboard navigation + screen reader (NVDA / VoiceOver smoke).

---

- [x] U4. **Synthesis card visual distinction**

**Goal:** The AI SUMMARY no longer blends with raw cards. Accent border + subtle background tint + slightly larger answer text marks it as the answer layer.

**Requirements:** R9, R10

**Dependencies:** U1 (synthesis card shares the arrival animation), U2 (typography baseline for "slightly larger" to make sense)

**Files:**
- Modify: `apps/hud/src/styles.css` — add `--synthesis-tint` token (light + dark variants), apply `background: var(--synthesis-tint)` to `.card.synthesis`, bump the answer-text size; the **left accent border already exists** at `styles.css:374` and is NOT re-added
- Modify: `apps/hud/src/sidebar.ts` — add `data-kind="synthesis"` attribute to the synthesis card root (the `.synthesis` class already exists; this attribute is just for explicit selection in tests)
- Test: `apps/hud/test/sidebar.test.ts` — class assertions, citation-chip readability, `data-kind` presence

**Approach:**
- The left accent border (`border-left-width: 3px; border-color: var(--accent)`) is already in styles.css. Do NOT re-add.
- Background tint: `--synthesis-tint` light mode ≈ `rgba(accent, 0.04)`; dark mode ≈ `rgba(accent, 0.06)`. Subtle wash so the answer reads as "the answer layer" without being garish.
- Answer text inside the synthesis card uses one step larger size (`text-base` instead of `text-sm`, or equivalent token).
- Citation chips `[N]` inside synthesis text — validate 4.5:1 contrast against the new tinted background (which differs from the raw-card background). Adjust chip text color or background if it slips.
- The existing always-on `animation: synthesis-fade-in 220ms ease-out` on `.card.synthesis` was already removed by U1 (synthesis card now mounts via `is-entering` / `card-enter` like raw cards).

**Patterns to follow:**
- Existing synthesis-fade-in keyframe in `styles.css` — the synthesis card already has distinctive entry; this unit gives it distinctive resting state too.
- The HUD's existing `--accent` token.

**Test scenarios:**
- Happy path: a synthesis card carries `.synthesis-card` class and a distinct `data-kind="synthesis"` attribute.
- Edge case: citation chips inside the synthesis card retain their existing render structure (test the chip elements still have `.citation-chip` class).
- Test expectation: visual properties (border, tint, text size) — assert via class presence; visual verification is manual.

**Verification:**
- Manual review in both light/dark: synthesis reads as "the answer" before reading any words. Citation chips remain legible.

---

- [x] U5. **Citation chips: hover preview + cite-pulse + keyboard a11y + retracted-source UX**

**Goal:** `[N]` chips become a complete interactive affordance. Hover shows the source title. Click (or keyboard Enter/Space) scrolls to and pulses the source card. Retracted sources degrade explicitly. Keyboard users get full parity.

**Requirements:** R11, R12, R13 (motion respects reduced-motion per U1 pattern)

**Dependencies:** U1 (`is-cited-target` cleanup uses the same setTimeout idiom; reduced-motion strategy inherited), U4 (citation chips must remain legible against the synthesis tint).

**What already exists in `apps/hud/src/sidebar.ts` (do NOT rebuild):**
- `.citation-chip` span rendering inside synthesis text (`#renderCitationChip`, ≈line 462)
- Click handler that does `document.querySelector('[data-card-id="…"]').scrollIntoView({ behavior: 'smooth', block: 'center' })` (lines 467–474)
- `el.dataset.cardId = card.cardId` on every card root (line 483)
- Existing test `citation chip click scrolls the matching raw card into view` (`apps/hud/test/sidebar.test.ts:236–249`)

**What this unit ADDS:**
- `title` attribute on the chip set to the source card's title text (hover preview)
- `cite-pulse` keyframe + `.card.is-cited-target` class added around `scrollIntoView`, removed via setTimeout (matches U1 cleanup pattern); animation ≈600ms, one-shot, box-shadow ring expand + border-color flash, `forwards` so the card settles cleanly
- Keyboard accessibility: change chip element from `<span>` to `<button type="button">` (or add `role="button"` + `tabindex="0"` + Enter/Space handlers). Visible focus ring (2px outline, `var(--accent)`) that meets contrast against both raw-card and synthesis-tinted backgrounds
- Retracted-source UX: when the lookup misses, set `data-source-retracted="true"` on the chip on mount-time if a render-time lookup fails, OR style retracted chips on click-time miss. Style as muted (opacity 0.5, optional strikethrough). Hover preview reads `Source no longer available`. Click is silent no-op.
- Already-in-view case: `scrollIntoView({ block: 'center' })` is a no-op when the target is fully visible; the `is-cited-target` pulse STILL fires (the pulse is the "here it is" signal even without scroll)

**Files:**
- Modify: `apps/hud/src/sidebar.ts` — extend `#renderCitationChip`: change element to `<button>` (or add ARIA), populate `title`, add keyboard handlers, wrap the existing scroll with `is-cited-target` class add + setTimeout removal
- Modify: `apps/hud/src/styles.css` — `cite-pulse` keyframe, `.card.is-cited-target { animation: cite-pulse 600ms ease-out forwards }`, `.citation-chip` focus-visible ring, `.citation-chip[data-source-retracted="true"]` muted treatment
- Test: `apps/hud/test/sidebar.test.ts` — extend existing test cluster

**Approach:**
- Citation chip rendering already wires the click → scroll. The new responsibility: set `title` from the matching source card's title at render time; add `is-cited-target` to the click handler's success branch; remove via `setTimeout(600ms)`.
- Keyboard handler: Enter and Space on the focused chip dispatch the same scroll + pulse logic. `<button type="button">` gets this for free; `role="button"` + `tabindex="0"` requires explicit listeners.
- Reduced-motion: the `cite-pulse` keyframe is governed by U1's global property-targeted reduced-motion block (`animation-duration: 0.01ms !important`). Under reduce, the pulse runs near-instantly — the visual signal collapses to a brief flash of the `forwards` end-state. Acceptable.
- Retracted source: explicit muted styling beats silent no-op. Users get a visible signal that the source is gone.

**Patterns to follow:**
- Existing `#renderCitationChip` at `apps/hud/src/sidebar.ts:462` — extend, don't replace.
- Existing setTimeout-class-removal idiom at `updateCard` (≈line 226).
- Test environment is **happy-dom**. Scroll spy uses **per-instance assignment**: `raw.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']` — see existing test at `apps/hud/test/sidebar.test.ts:242–248`. NOT prototype patching.
- Existing test cluster around scroll behavior covers the "target found / scrollIntoView called" assertion; the new assertions sit alongside it.

**Test scenarios:**
- Happy path: rendered citation chip's `title` attribute equals the source card's title text.
- Happy path: clicking a citation chip with matching `[data-card-id]` target → `scrollIntoView` called (existing pattern) AND the target gains `is-cited-target` class.
- Happy path: after 600ms (advance fake timers), `is-cited-target` is removed.
- Happy path: pressing Enter on a focused citation chip triggers the same scroll + pulse path as click.
- Happy path: pressing Space on a focused citation chip triggers the same scroll + pulse path as click.
- A11y: citation chip element type is `button` (or has `role="button"` + `tabindex="0"`); a visible `:focus-visible` outline rule exists in styles.css.
- Edge case: clicking a citation whose source has been retracted (no matching `[data-card-id]`) does NOT throw; no scroll; chip carries muted styling via `data-source-retracted="true"`.
- Edge case: hover preview on a retracted-source chip — `title` reads `Source no longer available`.
- Edge case: target already in viewport — `scrollIntoView` is a no-op (existing behavior); `is-cited-target` STILL applies; the pulse fires.
- Edge case: synthesis text cleaning that strips invalid `[N]` tokens (existing behavior) does not leave dangling event listeners on removed chip elements.

**Verification:**
- All test scenarios pass.
- **Manual:** keyboard-only navigation (Tab to a citation chip, Enter to activate) reliably scrolls and pulses the target. Screen reader announces the chip as a button with the source title as its name. Retracted-source chips are visibly muted; clicking them does nothing surprising. The pulse is visible (not just a subtle dim) against both light and dark card backgrounds.

---

## System-Wide Impact

- **Interaction graph:** Card rendering (`renderCard`), synthesis rendering (`renderSynthesisStart` / `appendSynthesisDelta` / `finalizeSynthesis`), and retraction (`retractCard`) all touch the new visual classes. No daemon-side changes; the contract surface is unchanged.
- **Error propagation:** All animations and visual treatments are CSS — no error paths to worry about. JS-driven click handler (U5) is fully wrapped in safe no-ops for the missing-target case.
- **State lifecycle risks:** The `is-entering` class must be removed on `animationend`; otherwise a sibling re-render could replay the animation. Test scenario in U1 pins this.
- **API surface parity:** None — purely visual. No changes to `CardEvent`, `RetrievalPipelineEvents`, or the WS protocol.
- **Integration coverage:** Existing sidebar tests cover the structural contracts. New tests in each unit extend that coverage to the new class/attribute assertions.
- **Unchanged invariants:** Card lifecycle (insert → maybe update → retract), synthesis lifecycle (start → deltas → done | error), HUD layout (one column, AI SUMMARY on top, raw cards below), connection banner behavior all unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Motion feels too aggressive or too subtle once it's running live. | Animation distances + durations are in CSS variables; tune in DevTools without recompiling. The Deferred to Implementation note already calls this out. |
| Source chip accent colors don't read in dark mode. | Per-theme variables with explicit dark-mode values. Manual contrast check during implementation, documented in PR description. |
| Citation hover tooltip feels chatty (fires too readily during scanning). | Native `title` attribute has browser-controlled delay. If insufficient, the deferred question reopens — implementer can add a CSS `transition-delay` on a `data-tooltip` rule. |
| Citation click scrolls to a card that's just out of view but isn't actually relevant after dedup (rare). | `scrollIntoView({ block: 'nearest' })` scrolls minimally — if the target is already visible, no jump. |
| `prefers-reduced-motion` accidentally over-suppresses (e.g., kills opacity fades, halts the connection-status pulse, erases non-motion transitions). | **Property-targeted** reduced-motion block sets `animation-duration` and `transition-duration` near-zero — does NOT use `animation: none`. `.status-live::before` infinite pulse is explicitly re-enabled inside the block (connection-down signal). Non-motion transitions (background, border-color) survive because the rule only shortens durations. Manual verification in both modes is the merge gate; the string-check structural test in U1 is a smoke test, not behavioral coverage. |
| Citation chip click on already-visible target is silent confusion. | Pulse fires regardless of scroll distance; the pulse is the "here it is" signal even when no scroll happens. Documented in U5 approach + test scenario. |
| Citation chip points to a source that never arrives (race between synthesis and card events, or daemon bug). | Same code path as retracted source: chip degrades to muted state with `title="Source no longer available"`. Click is silent no-op. |
| `forced-colors` / Windows High Contrast mode flattens chip tints and synthesis tint. | Accepted v1 degradation. Glyph + label remain (R8 requires non-color signals). Synthesis distinction relies on the (forced-colors-safe) border. If users report confusion, add a `@media (forced-colors: active)` block in v2. |
| Visual changes diverge between light and dark mode. | Every new token has both modes defined in `:root` / `:root.dark`. Manual review in both modes is part of every unit's Verification. |

---

## Documentation / Operational Notes

- Take a before/after screenshot pair for the PR description so reviewers see the polish without having to run the daemon.
- The new `--src-*` tokens are documented in a `styles.css` comment block so future connectors know where to add their color.
- No README changes needed — internal visual treatment.

---

## Sources & References

- **Origin document:** [docs/brainstorms/hud-visual-polish-requirements.md](../brainstorms/hud-visual-polish-requirements.md)
- Existing HUD code: `apps/hud/src/sidebar.ts`, `apps/hud/src/styles.css`, `apps/hud/src/main.ts`, `apps/hud/src/icons.ts`
- Tailwind v4 CSS-first config: `apps/hud/src/styles.css` (existing setup)
