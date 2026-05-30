---
title: "feat: Convert HUD to Next.js (React) for portal embedding + landing-page style parity"
type: feat
status: active
date: 2026-05-30
---

# feat: Convert HUD to Next.js (React)

## Overview

Build a Next.js 16 + React 19 + Tailwind v4 HUD at `apps/hud-next/` **side-by-side** with the existing `apps/hud/`. U5 swaps the daemon's HUD-serving path to the new build and removes the old code in a single atomic cutover. Until the cutover lands, the daemon can still ship from main with the old HUD bundle — no unshippable window.

Reuse the existing landing-page demo components (`upwell-landing-page/apps/web/app/components/demo/*`) as the visual foundation. Daemon still serves the bundle; future cross-origin portal embed (hosting the HUD inside the landing-page web app) becomes a follow-up, NOT this plan.

**Stack:** Next 16 (App Router) with `output: 'export'` for fully static client bundle → daemon serves the `out/` directory the same way it serves `dist/` today. No SSR, no Node runtime for the HUD — keeps the daemon's offline-first / zero-config model intact.

**Plan-numbering convention.** This plan defines its own U1–U5 implementation units. References to "polish-plan U1" / "polish-plan U5" denote the related plan at `docs/plans/2026-05-29-004-feat-hud-visual-polish-plan.md`. Polish-plan unit refs are always explicitly prefixed.

---

## Problem Frame

Two pressures converge on this change:

1. **Visual gap.** The landing-page demo at `/home/nathan/dev/upwell-landing-page/apps/web/app/components/demo/` is a polished React port of the HUD that *looks better than the real HUD*. Users see the demo, install Upwell, and the real product feels rougher. Closing the gap by rebuilding on the same components is faster than re-applying every polish iteration twice.
2. **Future portal embed.** The eventual product shape is "open `upwell.com/portal` in any browser to see the live meeting context from a daemon running on your machine." That target requires the HUD to be a React app the landing-page Next.js project can route to. Building the HUD on Next.js now lets the embed happen as a routing change later instead of a rewrite.

The change is HUD-only. Daemon protocol (WS message types, bootstrap script injection) is unchanged.

---

## Requirements Trace

- R1. New HUD is a Next.js 16 + React 19 + Tailwind v4 app under `apps/hud/`.
- R2. Build output is a static export (`output: 'export'`) — no SSR, no Node runtime needed at serve time.
- R3. Daemon serves the static export from `apps/hud/out/` (replacing the current `dist/` path resolution in `apps/daemon/src/cli/serve.ts`).
- R4. The `window.UPWELL_BOOTSTRAP` injection pattern (wsUrl + token) is preserved — Next.js renders a thin client wrapper that reads the bootstrap on mount.
- R5. WebSocket lifecycle (connect, exponential backoff up to 2s cap, visibility-driven force reconnect, status banner) is preserved as a React hook (`useUpwellSocket`).
- R6. All current HUD features ship with the conversion — no regressions: card stream (newest-first), source/type chips with accent colors + glyphs, synthesis card with streaming deltas + citation chips (hover preview + click-to-scroll + retracted-source UX + keyboard focus ring), theme toggle (light/dark via `.dark` on `<html>`), hover-safe scroll with pulse badge, empty-state rotating placeholder, retract cascade for synthesis-source retraction, **pinned-section** (top-of-stream pinned cards), **synthesis-announce** (SR-only aria-live region updated on synthesisDone).
- R7. The new HUD visually inherits the landing-page demo's component shapes (`HudCard`, `SynthesisCard`, `CardHeaderRow`, `Glyphs`) and CSS (`demo.css` becomes the foundation for `styles.css`).
- R8. The existing **53** HUD tests in `sidebar.test.ts` plus **8** in `ws-client.test.ts` (**61 total** — measured) are mapped to React-test equivalents in [docs/plans/notes/2026-05-30-hud-test-migration-manifest.md](notes/2026-05-30-hud-test-migration-manifest.md). The manifest is the spec for "no behavioral coverage gap"; U4 implementation cannot ship until every existing test row has either a Successor target or an explicit `WONTFIX` rationale.
- R9. CSP, bootstrap, and HUD bundle path in `apps/daemon/src/cli/serve.ts` are updated. CSP changes include SHA-256 hash allow-list for Next.js's inline hydration scripts. **U1 spike result:** the empty scaffold's `out/index.html` contains **4 inline `<script>` blocks** all of form `(self.__next_f=self.__next_f||[]).push(...)`. The hash-allow-list mechanism in U5 is required — was an open question at planning time, now confirmed.
- R10. Bundle size budget anchored to measured baseline. **U1 measurement:** empty scaffold's `out/_next/static/chunks/*.js` totals **180.8 KB gzipped** (611.8 KB raw) — the framework runtime floor for Next 16 + React 19 + Turbopack. The previous "stay under 250 KB" target was unrealistic against this floor. Revised target: **≤ 350 KB gzipped total** for the full HUD bundle (framework floor + demo components + Prism dynamic-import + WS hook + reducer). This is a ~6× increase over the current 29 KB-gzipped vanilla HUD — accepted as the cost of React, mitigated by the fact that the daemon serves locally over loopback (no network latency cost for end users).

---

## Scope Boundaries

- **No portal embed in this plan.** Hosting the HUD inside `upwell-landing-page/apps/web` as a route is a deliberate follow-up. This plan ships the React HUD served by the daemon at `127.0.0.1:4337/`.
- **No protocol changes.** WS message types in `apps/hud/src/types.ts` move into the new React app's `types.ts` unchanged. The daemon's WS broadcaster is untouched.
- **No new behavior.** The conversion is pure migration. The behavior surface defined by the U1–U5 HUD polish plan (`docs/plans/2026-05-29-004-feat-hud-visual-polish-plan.md`) is preserved verbatim.
- **No shared component package yet.** Landing-page demo components are **copied** into `apps/hud/app/` for this plan. Extracting them into a shared `packages/hud-ui/` consumed by both repos is a follow-up that becomes attractive once the portal embed lands.
- **No CSS framework swap.** Already on Tailwind v4 in both places; the conversion preserves it. No move to CSS-in-JS, styled-components, or a different CSS framework.
- **No new connectors or skills.** Pure HUD work.

### Deferred to Follow-Up Work

- **Cross-origin portal embed.** A future plan hosts the same React HUD inside `upwell-landing-page/apps/web` at `/portal/[token]`. Requires extracting components into a shared package and adding CORS to the daemon's WS endpoint.
- **Shared component package.** Once a second consumer (the portal embed) exists, extract `apps/hud/app/components/` into `packages/hud-ui/`.
- **Server components.** Static export now; revisit if a portal embed needs SSR or per-request data.

---

## Context & Research

### Relevant Code and Patterns

- `apps/hud/src/sidebar.ts` — current `Sidebar` class that owns DOM. Card rendering, synthesis lifecycle, citation chips, retract cascade. The behavioral spec for U4 of this plan.
- `apps/hud/src/ws-client.ts` — `WsClient` with exponential backoff, visibility handler, status events. Becomes the `useUpwellSocket` React hook (U3).
- `apps/hud/src/main.ts` — bootstrap entry. The `window.UPWELL_BOOTSTRAP` read + theme apply + sidebar wire-up. Becomes the Next.js client component bootstrap (U3).
- `apps/hud/src/types.ts` — WS server message union. Moves into the new HUD verbatim (no protocol changes).
- `apps/hud/src/styles.css` — Tailwind v4 with `@custom-variant dark`, source tokens, card-enter keyframe, reduced-motion guard, synthesis tint. The landing-page demo's `demo.css` is the reference for the polished version; this plan merges the two.
- `apps/hud/src/highlight.ts` — Prism-based code snippet highlighting. Reused as-is via dynamic import.
- `apps/hud/src/icons.ts` — Font Awesome inline-SVG renderer. Replaced by the landing-page demo's `glyphs.tsx` JSX components (which embed the same FA paths but as React components).
- `apps/daemon/src/cli/serve.ts` lines 37, 444–469 — `HUD_DIST` constant + the `/` and `/assets/*` route handlers. Path target changes from `dist/` to `out/`; the rest is unchanged.
- `/home/nathan/dev/upwell-landing-page/apps/web/app/components/demo/` — the reference implementation. Includes `hud-card.tsx`, `synthesis-card.tsx`, `card-bits.tsx`, `glyphs.tsx`, `meeting-demo.tsx`, `transcript.tsx`, `demo-timeline.ts`, `types.ts`, `demo.css`. These are pure-presentation components driven by the demo timeline; the conversion replaces the timeline driver with live WS events.
- `/home/nathan/dev/upwell-landing-page/apps/web/package.json` — Next 16.2.6 + React 19.2 + Tailwind v4 deps to mirror.

### Institutional Learnings

- `docs/plans/2026-05-29-004-feat-hud-visual-polish-plan.md` (U1–U5) shipped a coherent visual language. That work is the *target state* for the React HUD — the conversion must preserve the slide-down + fade card-enter animation, source/type chips with internal-convention accent palette, synthesis-tinted background with larger answer text, citation chips with hover/click/retracted UX, and the property-targeted `prefers-reduced-motion` rule that re-enables the `.status-live` pulse explicitly.
- `apps/hud/test/sidebar.test.ts` uses happy-dom and per-instance `scrollIntoView` spies (`raw.scrollIntoView = vi.fn()`). The React replacement tests should use `@testing-library/react` with the same happy-dom env and the same per-instance spy pattern.
- The recent partial-utterance and per-utterance dedup fixes don't affect this conversion — they're daemon-side.

### External References

- Next.js 16 static export: `output: 'export'` in `next.config.mjs` plus careful avoidance of any server-only features (no API routes, no `server` directives).
- React 19's `use()` hook makes WS message subscription cleaner than `useEffect`, but `useEffect` is fine for v1.

---

## Key Technical Decisions

- **Side-by-side migration into `apps/hud-next/`.** Old `apps/hud/` stays intact through U1–U4 so the daemon remains shippable from main throughout the conversion window. U5 is the atomic cutover: point the daemon at the new build output and delete the old code in the same PR. This adds a small "which one is current" cost during the window in exchange for shippability — net positive for a project that ships from main.
- **Static export, not SSR.** `next build` produces `apps/hud-next/out/` which the daemon serves the same way it serves `apps/hud/dist/` today. No Node runtime at HUD-serve time, no daemon needs to spawn a Next.js process. Keeps the offline-first promise.
- **CSP must allow Next.js inline hydration scripts. Mechanism: SHA-256 hash allow-list, computed at daemon startup.** Next 16 + App Router static exports ship inline `<script>` blocks containing `self.__next_f.push(...)` hydration data — verified by inspecting the landing-page's built `index.html`. The daemon's current strict `script-src 'self' 'nonce-XXX'` blocks these. Three options were considered:
  1. **Hash allow-list (chosen).** At daemon startup, parse `apps/hud-next/out/index.html`, find each inline `<script>` block, compute its SHA-256, and emit `script-src 'self' 'sha256-…' 'sha256-…' 'nonce-XXX'` in the CSP. Hashes change per HUD build; daemon reads them once at boot from disk. Bootstrap script still uses the per-request nonce. This preserves the security posture (no `unsafe-inline`, no nonce propagation through the export).
  2. *Per-request nonce injection into every chunk.* Rejected — requires post-processing the HTML on every request to insert the nonce attribute into every inline script. Brittle and breaks caching.
  3. *`unsafe-inline` for `script-src`.* Rejected — degrades the existing security posture and was the specific reason the nonce design exists.
- **CitationChip is NET-NEW, not copied from the demo.** The demo's `synthesis-card.tsx` renders citation chips as a bare `<span>[N]</span>` with no behavior. U4's CitationChip implements the polish-plan U5 contract: `<button type="button">` with `title` from source-card title, click-to-scroll using the `article[data-card-id="..."]` selector, `is-cited-target` cite-pulse class around scroll, keyboard Enter/Space, `:focus-visible` ring, `data-source-retracted` muted styling. The demo's display-span is the visual starting point only.
- **HudCard MUST set `data-card-id` on its root `<article>`.** The demo's `hud-card.tsx` does NOT include this attribute (the demo uses card ID only as a React key). U2's copy must add `<article data-card-id={card.cardId} ...>` — without it, CitationChip's `querySelector('article[data-card-id="…"]')` returns null and click-to-scroll silently fails. This is exactly the regression mode polish-plan U5 already paid to fix.
- **Reduced-motion CSS: production `styles.css` block wins outright; the demo's block is discarded.** The demo's `@media (prefers-reduced-motion: reduce)` uses `.upwell-hud .status-live::before { animation: none }` which directly contradicts the production block's `animation: pulse 1.6s !important` re-enable. Merging both in cascade order would silently kill the connection-down indicator for reduced-motion users. U2's CSS merge drops the demo's reduced-motion block entirely and adds a comment in the merged file explaining why.
- **`.upwell-hud` scoping wrapper from demo CSS: discarded.** Production styles.css uses bare selectors (`.card`, `.status-live`, `.citation-chip`). The HUD-Next app uses the same bare selectors. The `.upwell-hud` wrapper made sense in the landing page (HUD lives alongside marketing content); doesn't apply when the entire `<body>` IS the HUD.
- **Demo-only animations dropped: `synthesis-reveal` grid 0fr→1fr expand, `card-collapse` exit animation, `sources-in` cascade.** The production HUD uses `.is-entering` / `card-enter` on the card element directly (polish-plan U1). Adopting the demo's wrapper-based reveal would be new behavior, which the plan's "no new behavior" constraint forbids. The demo animations are visually nicer but out of scope; revisit in a future polish pass.
- **Copy the landing-page demo components, don't symlink or import across repos.** Path of least resistance for v1. Components evolve in `apps/hud/app/components/` once copied; landing-page demo can stay frozen at its current point or follow along independently. A shared `packages/hud-ui/` extraction is a follow-up triggered by the cross-origin portal embed plan.
- **The demo components' "fake card data" props become real `CardEvent` props.** The landing-page demo types deliberately mirror the HUD's `CardEvent`/`SynthesisStart` shapes, so the wiring is mostly type rename + drop the demo-timeline driver. No component-by-component rewrite.
- **One bootstrap script, two render paths during dev.** Development uses Next's dev server (`pnpm --filter @upwell/hud dev` on port 3001 with a hardcoded `window.UPWELL_BOOTSTRAP` for offline dev). Production serves the static export through the daemon at port 4337, with the daemon injecting `UPWELL_BOOTSTRAP` into the export's `index.html` exactly as it does today.
- **WS connection lives in a React hook (`useUpwellSocket`) called once at the app root.** It owns the `WsClient` instance, exposes `status`, and dispatches server messages onto a `useReducer`-managed app state (card list, synthesis records, retract state, meeting mode). Components consume via `useContext(AppStateContext)` — no prop-drilling.
- **No state management library.** `useReducer` + Context is sufficient at this scale. The daemon already does the heavy state work; the HUD just reflects events.
- **CSS strategy: keep `demo.css` as the foundation, merge in the HUD's `styles.css` rules that don't exist in demo (theme toggle, reduced-motion guard, empty-state, hover-safe scroll badge, connection banner).** Tailwind v4 `@source` directives are updated to scan `.tsx` files.

---

## Open Questions

### Resolved During Planning

- *Where does the Next.js HUD live?* New `apps/hud-next/` directory, side-by-side with `apps/hud/` during U1–U4. U5 deletes `apps/hud/` in the cutover.
- *Static export or SSR?* Static export (`output: 'export'`). No Node runtime.
- *Copy components from landing page or share?* Copy now; extract to shared package when the portal embed lands.
- *State management?* `useReducer` + Context. Sufficient at this scale.
- *Dev server port?* 3001 (HUD), keeping 4337 for the daemon and 3000 for the landing-page web app so all three can run side-by-side.
- *CSP for Next.js inline scripts?* SHA-256 hash allow-list computed at daemon startup. See Key Technical Decisions.
- *Bundle target?* Anchored to measured floor in U1, not estimated. See R10.
- *MockMode toggle for design iteration without daemon?* Out of scope. Dev iteration uses a running daemon (3001 → 4337) or hardcoded fixture data injected via `window.UPWELL_BOOTSTRAP_FIXTURES` at dev time. No `demo-timeline.ts` import in production code paths.

### Deferred to Implementation

- Exact Tailwind v4 CSS variable merging (token-by-token reconciliation of `styles.css` and `demo.css`) — emerges when the implementer puts the files side by side.
- Whether `demo-timeline.ts` should be preserved as a *dev-mode mock* (so the HUD can be styled without a running daemon) or deleted entirely. Probably preserved as a `MockMode` toggle for design iteration.
- Whether the existing `highlight.ts` Prism wrapper imports cleanly into a React component or needs a `useEffect`-based mount.

---

## Implementation Units

- [ ] U1. **Next.js scaffold in `apps/hud-next/` + Test Migration Manifest + bundle baseline + inline-script spike**

**Goal:** Create the new Next.js project at `apps/hud-next/` (side-by-side with the existing `apps/hud/`), measure the bundle floor from the empty scaffold, verify the inline-script CSP hypothesis, and produce the test-migration manifest. The existing `apps/hud/` is untouched in this unit — preserves shippability of main.

**Requirements:** R1, R2, R8 (manifest), R10 (measured baseline)

**Dependencies:** None

**Files:**
- Create: `apps/hud-next/package.json` — name `@upwell/hud-next`, scripts: `dev` (`next dev -p 3001`), `build`, `start`, `lint`, `typecheck`, `test`. Deps: `next@^16.2.6`, `react@^19.2.0`, `react-dom@^19.2.0`. Dev deps: `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/jest-dom`, `@vitejs/plugin-react`, `vitest`, `happy-dom`, `@tailwindcss/postcss`, `tailwindcss@^4`, ESLint config.
- Create: `apps/hud-next/next.config.mjs` — `{ output: 'export', images: { unoptimized: true }, reactStrictMode: true }`
- Create: `apps/hud-next/tsconfig.json` — extends the workspace base, includes `app/` and `test/`
- Create: `apps/hud-next/postcss.config.mjs` — `{ plugins: { '@tailwindcss/postcss': {} } }`
- Create: `apps/hud-next/eslint.config.mjs` — React + Next.js + project conventions
- Create: `apps/hud-next/app/layout.tsx` — root layout with `<html lang="en" suppressHydrationWarning>` + body
- Create: `apps/hud-next/app/page.tsx` — placeholder page (empty container; U4 fills it)
- Create: `apps/hud-next/app/styles.css` — Tailwind v4 directives only; tokens added in U2
- Create: `apps/hud-next/test/.gitkeep`
- Create: `docs/plans/notes/2026-05-30-hud-test-migration-manifest.md` — see Approach
- Modify: `pnpm-workspace.yaml` (root) — register `apps/hud-next` as a workspace if not pattern-matched

**Approach:**
- **Side-by-side scaffold.** `apps/hud/` is untouched. The new Next.js project lives at `apps/hud-next/`. Both can build independently. The daemon continues to point at `apps/hud/dist/` until U5 swaps the path.
- **Inline-script verification spike (CSP).** Once the empty scaffold builds, inspect `apps/hud-next/out/index.html` and the chunk files for `<script>` tags WITHOUT a `src` attribute. Record the count and their `self.__next_f.push(...)` content shape. This confirms the SHA-256 hash-allow-list decision in Key Technical Decisions — if the spike shows zero inline scripts, the CSP problem evaporates and U5's mechanism simplifies; if it shows inline scripts, U5 implements the hash allow-list.
- **Bundle baseline measurement.** Run `next build` on the empty scaffold. Sum gzipped sizes of `out/_next/static/chunks/*.js`. Record the number. This is the floor — every additional component is added to it. The R10 budget becomes `floor + 50% headroom`, capped at a reasonable max (e.g., 300 KB compressed total). Update R10 with the actual number once measured.
- **Test Migration Manifest.** Run `grep -nE "(it|test)\(" apps/hud/test/sidebar.test.ts apps/hud/test/ws-client.test.ts` to enumerate every existing test name. Write a markdown file `docs/plans/notes/2026-05-30-hud-test-migration-manifest.md` listing each test name, its source file/line, and the planned successor in `apps/hud-next/test/` (or `WONTFIX: <reason>`). This manifest is the binding contract for "equivalent coverage" — U4 cannot ship until every row is satisfied.

**Patterns to follow:**
- `/home/nathan/dev/upwell-landing-page/apps/web/package.json`, `next.config.mjs`, `postcss.config.mjs`, `tsconfig.json` — direct mirror for the dependency versions and config shape. The landing-page already uses `reactStrictMode: true`; mirror that.
- The empty Next.js project should `next build` without any application code so the bundle baseline reflects framework cost only.

**Test scenarios:**
- Test expectation: none — pure scaffolding. Verification is bundle measurement + manifest production + CSP spike result.

**Verification:**
- `pnpm --filter @upwell/hud-next build` exits 0 and produces `apps/hud-next/out/index.html`.
- `pnpm --filter @upwell/hud-next typecheck` clean.
- `pnpm --filter @upwell/hud-next dev` starts on port 3001 serving a blank page.
- Bundle baseline number recorded in this plan's R10 (replacing the unanchored 250 KB estimate).
- Test Migration Manifest exists at `docs/plans/notes/2026-05-30-hud-test-migration-manifest.md` with one row per existing test.
- CSP spike result recorded: count and shape of inline `<script>` blocks in the empty scaffold's `out/index.html`. If zero, simplify U5; if non-zero, U5's hash mechanism is required.

**Patterns to follow:**
- `/home/nathan/dev/upwell-landing-page/apps/web/next.config.mjs` (or equivalent) and `package.json` — direct precedent for Next 16 + React 19 + Tailwind v4.

**Test scenarios:**
- Test expectation: none for this unit — pure scaffolding with no behavior. Verification is `next build` succeeding and `out/` containing the expected files.

**Verification:**
- `pnpm --filter @upwell/hud build` exits 0 and produces `apps/hud/out/index.html`.
- `pnpm --filter @upwell/hud typecheck` clean.
- `pnpm --filter @upwell/hud dev` starts a Next dev server on port 3001 serving a blank page (intentional — U2/U3/U4 add content).

---

- [ ] U2. **Port landing-page demo components + merge CSS**

**Goal:** Copy the polished React components from the landing-page demo into `apps/hud/app/components/` and merge the foundation CSS so the visual language is in place before any wiring.

**Requirements:** R7

**Dependencies:** U1

**Files:**
- Create: `apps/hud-next/app/components/hud-card.tsx` — copied from `upwell-landing-page/apps/web/app/components/demo/hud-card.tsx` PLUS the `data-card-id` modification
- Create: `apps/hud-next/app/components/synthesis-card.tsx` — copied (note: citation-chip render is just a placeholder span here; the interactive component is built in U4)
- Create: `apps/hud-next/app/components/card-bits.tsx`
- Create: `apps/hud-next/app/components/glyphs.tsx` — copied PLUS TypeGlyph a11y override (role=img, aria-label)
- Create: `apps/hud-next/app/types.ts` — copied from `upwell-landing-page/apps/web/app/components/demo/types.ts` AND merged with the existing `apps/hud/src/types.ts` WS message shapes. The demo's `DemoCard` becomes the production `CardEvent` (already-aligned shapes), and the WS message union is added.
- Modify: `apps/hud-next/app/styles.css` — merged stylesheet per the Token Reconciliation Table + the scoping/reduced-motion decisions above
- Create: `docs/plans/notes/2026-05-30-hud-token-reconciliation.md` — the reconciliation table artifact

**Approach:**
- Copy verbatim first; rename demo-specific imports (e.g., `./types` paths) to the new HUD locations.
- Components stay presentation-only (consume props; emit no DOM-level side effects).
- Reconcile the type aliases: `DemoCard` ↔ `CardEvent` (both have `id/cardId, source, type, title, snippet, rank`). The conversion path is a type rename pass; no field changes.
- Add `'use client'` directives to any component that uses hooks (synthesis-card if it has streaming animation state; otherwise none).
- **Required modifications to copied components (not literal copies):**
  - `hud-card.tsx` — ADD `data-card-id={card.cardId}` to the root `<article>` element. The demo omits this attribute; without it, citation-chip click-to-scroll silently fails. See Key Technical Decisions.
  - `glyphs.tsx` — `TypeGlyph` SVGs: REPLACE the demo's `aria-hidden={true}` with `role="img" aria-label={typeLabel}`. Polish-plan U3 explicitly requires this — `title` on a non-interactive span is unreliable across screen readers; aria-label on the glyph wrapper is the load-bearing signal. Update `card-bits.tsx` accordingly so the type label text becomes purely visual (or is moved to aria-label if visual text is dropped).
- **CSS merge strategy (Token Reconciliation Table required):** produce a markdown artifact `docs/plans/notes/2026-05-30-hud-token-reconciliation.md` listing every CSS custom property used by either `apps/hud/src/styles.css` (HEAD) or `upwell-landing-page/apps/web/app/components/demo/demo.css`, with three columns: current HEAD value, demo value, chosen merged value + one-line rationale. Reviewable, diffable. The implementer cannot punt; the reviewer can audit. Without this, the polish-plan visual investment is at risk of regressing through token drift.
- **CSS scoping:** discard the demo's `.upwell-hud` wrapper. Bare selectors (production model) win — the HUD-Next app's entire `<body>` is the HUD.
- **CSS reduced-motion:** discard the demo's `@media (prefers-reduced-motion: reduce)` block entirely. The production block (property-targeted, re-enables `.status-live::before` pulse) is the sole reduced-motion mechanism. Add an inline comment in the merged stylesheet noting why the demo block was rejected (it killed the connection-state indicator).
- **Demo-only animations dropped:** the demo's `synthesis-reveal` grid expand and `card-collapse` exit animation are not preserved (covered in Key Technical Decisions).

**Patterns to follow:**
- Landing-page demo components are already idiomatic React. Keep the same shapes.
- `apps/hud/src/styles.css` HEAD — the polish plan's CSS is the source of truth for HUD-specific styles not present in demo.css.

**Test scenarios:**
- Happy path (snapshot): `<HudCard card={mockCard} />` renders with the expected source-chip class, title, snippet, and meta row.
- Happy path: `<SynthesisCard ... />` renders the cited sources sub-list and the answer text body.
- Edge case: `<HudCard card={{...mockCard, type: 'unknown'}} />` renders without the type-chip glyph.
- Test expectation: visual styling verified by class presence; computed-style assertions are manual.

**Verification:**
- `pnpm --filter @upwell/hud build` clean.
- Visual smoke: `pnpm --filter @upwell/hud dev`, manually navigate to `localhost:3001`, the home page renders with at least one mock card looking like the landing-page demo.

---

- [ ] U3. **WebSocket React hook + app state context + theme**

**Goal:** Replace `WsClient`, `main.ts`'s bootstrap logic, and theme-toggle in a React-native way. The hook owns the connection lifecycle; a context distributes app state; theme toggle is a small component reading localStorage.

**Requirements:** R4, R5 (bootstrap + WS lifecycle preservation)

**Dependencies:** U1, U2

**Files:**
- Create: `apps/hud/app/hooks/use-upwell-socket.ts` — port of `ws-client.ts` as a React hook. Returns `{ status, lastEvent }` or dispatches into the reducer.
- Create: `apps/hud/app/state/app-state.tsx` — `AppStateContext`, `appStateReducer` handling card / cardUpdated / cardRetracted / synthesisStart / synthesisDelta / synthesisDone / synthesisError / synthesisRetracted / meetingStarted / meetingEnded.
- Create: `apps/hud/app/components/theme-toggle.tsx` — applies `.dark` class to `<html>` based on localStorage + OS preference.
- Create: `apps/hud/app/components/bootstrap.tsx` — `'use client'`; reads `window.UPWELL_BOOTSTRAP`, instantiates the hook, wraps children in `AppStateProvider`.
- Modify: `apps/hud/app/layout.tsx` — root html structure, theme initial-state script (inline `<script>` to avoid flash-of-wrong-theme).
- Modify: `apps/hud/app/page.tsx` — render `<Bootstrap>` wrapping `<HudShell>` (next unit).
- Test: `apps/hud/test/use-upwell-socket.test.ts` — equivalent of the old ws-client.test.ts, asserts backoff cap, visibility-driven force reconnect, status transitions.
- Test: `apps/hud/test/app-state.test.ts` — reducer cases for each server message.
- Test: `apps/hud/test/theme-toggle.test.tsx` — toggles `.dark` on `<html>`, persists to localStorage.

**Approach:**
- `useUpwellSocket` instantiates a `WsClient` **INSIDE `useEffect`** (not in `useRef` or module scope), with cleanup calling `wsClient.stop()`. This is safe under React 19 StrictMode double-mount: first effect creates + connects, cleanup tears down (`stop()` sets `#closed = true`), second effect creates a fresh connection — no orphaned listeners on `document.visibilitychange`. A U3 test mounts the hook, unmounts, mounts again, asserts no duplicate-event dispatches.
- Reuse the existing `WsClient` logic verbatim (backoff math, visibility handler). The hook is a thin React adapter; the connection logic stays in the class.
- The reducer is the simplest possible: switch on `msg.type`, return new state. No middleware, no thunks. Each message type gets its own test.
- **Theme toggle inline script (CSP + safety):**
  - Implemented via `<script dangerouslySetInnerHTML={{ __html: themeInit }} />` in `layout.tsx` (literal JSX `<script>{code}</script>` does NOT execute as a script in React — the demo uses dangerouslySetInnerHTML).
  - The script wraps `localStorage.getItem(...)` in `try/catch`. If localStorage throws (Safari private mode, quota-exceeded), fall back to `window.matchMedia('(prefers-color-scheme: dark)').matches`. If matchMedia is unavailable, default to light. The script MUST NOT throw under any condition — it runs before React hydration; a throw leaves the page broken.
  - The script's content is static across builds. Its SHA-256 hash goes into the CSP allow-list alongside Next.js's inline-script hashes (see U5).
  - `<html lang="en" suppressHydrationWarning>` is required on the root element — the inline script mutates `documentElement.classList` before React hydrates, producing a benign hydration mismatch that this attribute silences.
- `ThemeToggle` component's initial React state reads from `document.documentElement.classList.contains('dark')` synchronously during render — matches the class the inline script already applied, no flash.
- `<SynthesisStream>` keeps `aria-live="off"` on the streaming body (mirror demo) and renders a separate `sr-only` `<div aria-live="polite">` updated ONLY on `synthesisDone` (mirror current HUD's `#synthesis-announce`). Avoids both screen-reader spam during streaming and silence on completion.

**Execution note:** Test-first. The reducer handles 8+ server message types and the WS hook re-implements backoff/visibility/StrictMode-safe lifecycle. Write tests for each reducer message type and each WS lifecycle transition before wiring components.

**Patterns to follow:**
- `apps/hud/src/ws-client.ts` HEAD — copy the backoff math + visibility handler verbatim, just wrap in hook.
- `apps/hud/src/main.ts` HEAD — theme detection logic.

**Test scenarios:**
- Happy path: `useUpwellSocket` with a fake `WsFactory` transitions status 'connecting' → 'open' on `onopen`.
- Happy path: `appStateReducer` handles `{type:'card', card}` by appending to the cards list.
- Happy path: `appStateReducer` handles `{type:'synthesisDelta'}` by appending text to the active synthesis.
- Edge case: `cardRetracted` removes the card and cascades to any synthesis citing it.
- Edge case: visibility change while disconnected force-reconnects immediately.
- Edge case: theme toggle without localStorage available falls back to OS preference.
- Integration: a chain of `synthesisStart` → 3 deltas → done updates state idempotently.

**Verification:**
- All test scenarios pass.
- `pnpm --filter @upwell/hud build` clean; `out/` includes the inline theme script.

---

- [ ] U4. **HUD shell components — full DOM region inventory, citation chip (NET-NEW), pinned-section, synthesis-announce**

**Goal:** Implement the React components that consume `AppStateContext` and render the live HUD with full behavior parity vs `sidebar.ts`. Every DOM region in the current HUD has a corresponding React surface.

**Requirements:** R6, R8 (preserves polish-plan behavior + test coverage per the Test Migration Manifest from U1)

**Dependencies:** U2, U3

**Files:**
- Create: `apps/hud-next/app/components/hud-shell.tsx` — full layout: header (meeting status pill, theme toggle, connection banner), **pinned-section** (top-of-stream pinned cards), `<SynthesisStream>`, `<CardStream>`, **`<SynthesisAnnounce>`** (sr-only aria-live region), `<EmptyState>`, hover-safe scroll badge. Every region from the current HUD is accounted for.
- Create: `apps/hud-next/app/components/card-stream.tsx` — renders `state.cards` in newest-first order with `is-entering` animation on mount; manages the hover-safe scroll/badge.
- Create: `apps/hud-next/app/components/pinned-section.tsx` — pinned cards stay at the top, removed from the stream when pinned.
- Create: `apps/hud-next/app/components/synthesis-stream.tsx` — renders active syntheses above the card stream; handles streaming `appendDelta`, citation-chip parsing, retract cascade.
- Create: `apps/hud-next/app/components/synthesis-announce.tsx` — sr-only `<div aria-live="polite">`, populated only on `synthesisDone` (mirrors current HUD's `#synthesis-announce`).
- Create: `apps/hud-next/app/components/empty-state.tsx` — rotating placeholder messages (10s interval).
- Create: `apps/hud-next/app/components/citation-chip.tsx` — **NET-NEW component, NOT copied from the demo.** Demo's citation chip is an inert `<span>[N]</span>`. This component implements the polish-plan U5 contract: `<button type="button">` with `title` from source-card title, click handler that does `document.querySelector('article[data-card-id="…"]').scrollIntoView({block:'center'}) + add 'is-cited-target' class for 700ms`, keyboard Enter/Space (native button behavior), `:focus-visible` ring, `data-source-retracted` + muted styling on retracted-source click.
- Modify: `apps/hud-next/app/page.tsx` — render `<HudShell>` inside `<Bootstrap>`.
- Test: `apps/hud-next/test/card-stream.test.tsx`
- Test: `apps/hud-next/test/pinned-section.test.tsx`
- Test: `apps/hud-next/test/synthesis-stream.test.tsx`
- Test: `apps/hud-next/test/synthesis-announce.test.tsx`
- Test: `apps/hud-next/test/citation-chip.test.tsx`
- Test: `apps/hud-next/test/empty-state.test.tsx`
- Test: `apps/hud-next/test/hud-shell.test.tsx`

**Note on R6 — phantom feature removed.** The original draft listed "em-dash scrubbing" as a preserved feature. A search of `apps/hud/src/` finds no such scrubbing — neither in `finalizeSynthesis` nor in the `EMPTY_STATE_MESSAGES` constant. The line was aspirational. R6 has been corrected to drop it. If em-dash handling is desired, it becomes a new feature in a future plan with a defined scrubbing rule.

**Approach:**
- Each component is a function component reading from `AppStateContext`. No internal state except for animation-cleanup timers and hover/scroll local state.
- `is-entering` class added on mount in a `useEffect` with `requestAnimationFrame` + cleanup via `setTimeout(400)` (matches U1 of the polish plan).
- Citation-chip click handler: `document.querySelector('article[data-card-id="${cardId}"]')` then `scrollIntoView` + add `is-cited-target` class for 700ms. Same selector specificity (`article[data-card-id=...]`) as the polish-plan fix.
- Empty state: rotates via `useEffect` with `setInterval(10000)`, cleared on unmount.

**Execution note:** Test-first. The polish plan's 53 tests verify a lot of behavior the React components must reproduce; write the React equivalents before implementing.

**Patterns to follow:**
- `apps/hud/src/sidebar.ts` HEAD — behavior reference. Every public method translates to a state-aware component render.
- `apps/hud/test/sidebar.test.ts` HEAD — test scenarios translate directly to React Testing Library tests.

**Test scenarios:**
- Happy path: `<CardStream>` renders incoming cards newest-first; new card has `is-entering` class on mount; class is removed by 400ms `setTimeout`.
- Happy path: `<SynthesisStream>` renders a streaming synthesis with cursor; cursor disappears on `synthesisDone`.
- Happy path: `<CitationChip>` is a `<button>` with `data-card-id`, `title` set to source card title, Enter/Space keyboard activation, `:focus-visible` focus ring rule.
- Happy path: `<EmptyState>` rotates messages every 10s.
- Edge case: clicking a citation chip whose source has been retracted sets `data-source-retracted="true"` and updates `title` to "Source no longer available"; no `scrollIntoView` call.
- Edge case: hover-safe scroll suppresses auto-scroll-to-top, shows badge with pending count; badge click + mouseleave both flush.
- Integration: a synthesisStart → deltas → done sequence renders the streaming text, finalized text, and citation chips correctly.

**Verification:**
- All test scenarios pass — equivalent or better coverage than the 53 existing HUD tests.
- `pnpm --filter @upwell/hud build` clean; bundle under 250 KB compressed.
- Manual: connect to a running daemon, speak a question, see the cards animate in, synthesis stream, click a citation chip, scroll behavior works, theme toggle works.

---

- [ ] U5. **Atomic cutover — daemon serves `apps/hud-next/out/`, CSP hashes inline scripts, old `apps/hud/` removed**

**Goal:** In a single PR: repoint the daemon's HUD-serving routes from `apps/hud/dist/` to `apps/hud-next/out/`, add `@fastify/static` to serve Next.js chunked assets under `/_next/*`, compute SHA-256 hashes of the export's inline `<script>` blocks at startup and emit them in the CSP, and delete the old `apps/hud/` directory. Atomic = before the PR, daemon ships the old HUD; after, daemon ships the new HUD.

**Requirements:** R3, R4, R9

**Dependencies:** U1, U4

**Files:**
- Modify: `apps/daemon/package.json` — add `@fastify/static@^8` for chunked-asset serving (no bespoke handler — avoids path-traversal and MIME-type bugs).
- Modify: `apps/daemon/src/cli/serve.ts` — `HUD_DIST` constant points at `apps/hud-next/out`. Register `@fastify/static` plugin scoped to `/_next/static/`, root: `${HUD_DIST}/_next/static/`. Keep the existing bootstrap-injection logic at `/`.
- Modify: `apps/daemon/src/server/csp.ts` — accept an array of script-hash strings; emit them in `script-src` alongside `'self'` and the per-request nonce.
- Create: `apps/daemon/src/server/hud-inline-hashes.ts` — at daemon startup, read `apps/hud-next/out/index.html` and any chunk HTML, extract every `<script>` tag without `src`, compute SHA-256 of its body, emit `sha256-${base64}` strings. Memoize result. Errors (file missing) log a clear warning and return an empty array (CSP still strict, page may not hydrate — better than silent loosening).
- Delete: `apps/hud/` (the entire old directory). This is the cutover.
- Modify: `pnpm-workspace.yaml` — drop `apps/hud` from workspace patterns if explicitly listed; the renamed `apps/hud-next/` could optionally be renamed to `apps/hud/` at this point if desired (otherwise stays).

**Approach:**
- The CSP hash mechanism: at startup, scan the static export's HTML for inline scripts. Compute hashes. Store on the server instance. Every CSP emission (request middleware) reads from this store. Hashes change only when the HUD build changes — a daemon restart picks up new hashes. No per-request overhead.
- `@fastify/static` handles MIME types, range requests, path traversal protection, and the `/_next/static/{buildId}/...` shape. Configure with `prefix: '/_next/static/'` and `root: path.join(HUD_DIST, '_next', 'static')`. Add a long-lived `Cache-Control` since Next.js chunks are content-hashed.
- The bootstrap-injection logic at `/` stays the same — string-replace `</head>` with the `<script nonce="…">window.UPWELL_BOOTSTRAP = …</script></head>` injection. The bootstrap script's nonce comes from the per-request nonce; the inline hydration scripts come from the hash allow-list. Both authenticate; no `unsafe-inline`.
- **Cutover sequencing:** the PR that lands U5 is the ONLY change that breaks the old HUD. Up until U5, `apps/hud/dist/` exists and the daemon ships normally. U5 is reviewable as a single atomic diff: old code deleted, daemon repointed, CSP hashes wired. Easy to revert if something breaks in prod (revert the PR, daemon goes back to the old HUD until the issue is fixed).

**Patterns to follow:**
- `apps/daemon/src/cli/serve.ts` `wireHudRoutesOnApp` HEAD — bootstrap-injection logic stays; asset routes are replaced by `@fastify/static`.
- `apps/daemon/src/server/csp.ts` — extend the existing builder; don't replace.

**Test scenarios:**
- Happy path: `computeInlineScriptHashes(htmlString)` returns a stable array of `sha256-…` strings for known inline-script content.
- Happy path: `buildCspHeader` includes both the per-request nonce AND the computed hashes in `script-src`.
- Edge case: `out/index.html` missing → `computeInlineScriptHashes` logs a clear warning and returns `[]`.
- Integration (manual): start daemon, open `localhost:4337/`, browser console shows no CSP violations, HUD hydrates and connects.

**Verification:**
- All test scenarios pass.
- `pnpm --filter @upwell/daemon typecheck` clean.
- `pnpm --filter @upwell/daemon test` passes including new csp/hashes tests.
- Manual: full integration — daemon + HUD + a real meeting — speak a question, see cards animate in, click a citation chip, theme toggle works, reduced-motion mode works.
- Browser DevTools "Network" tab confirms `/_next/static/chunks/*.js` requests succeed with the expected `Cache-Control` headers.
- Browser DevTools "Console" shows zero CSP violations on any user flow.

---

## System-Wide Impact

- **Interaction graph:** HUD-only. Daemon's WS broadcaster, retrieval pipeline, classifier, synthesizer all unchanged. The protocol between daemon and HUD (WS message types) is preserved verbatim.
- **Error propagation:** WS disconnect → `useUpwellSocket` flips status to 'disconnected' → connection banner displays → reconnect backoff fires. Identical to current behavior.
- **State lifecycle risks:** React unmount needs to dispose the WS connection cleanly. `useUpwellSocket`'s cleanup function calls `wsClient.stop()`. Verified by the hook's test.
- **API surface parity:** No daemon API changes. No HUD-consumer changes (the daemon is the only HUD consumer).
- **Integration coverage:** Manual integration in U4/U5 verification covers the daemon ↔ HUD wire end-to-end. Hard to automate without spinning the daemon in tests; the U3/U4 React component tests cover the HUD's reaction to WS events using a fake message-emitter.
- **Unchanged invariants:** WS protocol (every message type), session-token bearer auth, CSP shape, HUD bootstrap pattern (window.UPWELL_BOOTSTRAP), card lifecycle (insert → updated → retracted), synthesis lifecycle (start → deltas → done | error → retracted), theme toggle behavior, hover-safe scroll badge logic, empty-state rotation, citation-chip interaction surface.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bundle size blows past the 250 KB budget once React + Next runtime + Tailwind are in. | Next 16 + React 19's RSC-aware bundler is aggressive; verify with `next build` analysis. If over budget, dynamic-import the Prism syntax highlighter (already lazy in the current HUD's pattern). |
| Theme-toggle flash-of-wrong-theme on initial load (Next.js + client-only theme detection). | Inline `<script>` in `layout.tsx` that runs before React hydration, reads localStorage, applies `.dark` to `<html>`. Standard pattern. |
| `prefers-reduced-motion` block coverage is harder to verify in React Testing Library than in the vanilla DOM. | Same structural smoke test as U1 of the polish plan — assert the CSS rule exists in `styles.css`. Real behavior validation is manual (DevTools "Emulate CSS prefers-reduced-motion: reduce"). |
| Next.js static export breaks if any component accidentally uses a server-only feature. | Lint with the Next.js rules; CI build catches violations. |
| Behavior regression vs the 53 existing HUD tests. | Test-first per U4's Execution note. Translate each existing test scenario into a Testing Library equivalent before implementing the component. |
| CSP rejects Next.js's chunk script tags. | Next.js static export uses regular `<script src>` tags (not inline), which the existing `script-src 'self' 'nonce-...'` permits. Verify by manual smoke; if rejected, expand `script-src` to include the chunked paths. |
| Citation chip selector specificity bug surfaces again — `[data-card-id="..."]` matches the chip itself. | Polish plan's fix already pinned `article[data-card-id="..."]` as the correct selector. U4's `<CitationChip>` test asserts this verbatim. |

---

## Documentation / Operational Notes

- Update `AGENTS.md` and `apps/hud/README.md` (if present) to note the Next.js stack and the static-export workflow.
- The `pnpm --filter @upwell/hud build` script now runs `next build` instead of the previous esbuild step. Document in the README.
- Dev workflow: `pnpm --filter @upwell/hud dev` on port 3001 with a mock bootstrap; `pnpm --filter @upwell/daemon dev serve` on port 4337 for full integration testing.
- Bundle size monitoring: `apps/hud-next/scripts/bundle-check.mjs` sums **gzipped** sizes of every file under `out/_next/static/chunks/*.js` (using Node's built-in `zlib.gzipSync`). Fails the CI build if total exceeds the budget set in U1's measured baseline + headroom. Emits the actual number on every run so PR reviewers see it. Wired into the existing CI step that runs on every PR. Replaces the current 102 KB ceiling on `apps/hud/dist/main.js` (which itself was raw, not gzipped — note the metric change in PR description so reviewers don't compare apples to oranges).

---

## Sources & References

- Landing-page demo components: `/home/nathan/dev/upwell-landing-page/apps/web/app/components/demo/`
- HUD polish plan (target visual state): [docs/plans/2026-05-29-004-feat-hud-visual-polish-plan.md](2026-05-29-004-feat-hud-visual-polish-plan.md)
- Current HUD source (behavior reference): `apps/hud/src/`
- Daemon HUD-serving routes: `apps/daemon/src/cli/serve.ts:wireHudRoutesOnApp`
- Next.js 16 static export docs (via `output: 'export'`)
