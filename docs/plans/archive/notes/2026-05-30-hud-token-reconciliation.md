# HUD CSS Token Reconciliation Table

**Plan:** [docs/plans/2026-05-30-001-feat-hud-nextjs-conversion-plan.md](../2026-05-30-001-feat-hud-nextjs-conversion-plan.md) — U2 deliverable.

**Conclusion:** The production `apps/hud/src/styles.css` (HEAD, 693 lines, post-polish-plan U1–U5) already encodes the merged decisions from the polish plan. The landing-page demo's `demo.css` (456 lines) used a parallel but simpler token set tuned for a marketing surface. The reconciliation table below shows what was kept, what was rejected, and why.

**Outcome:** `apps/hud-next/app/styles.css` = production styles.css verbatim (with `@source` directive updated to scan `.tsx` files instead of `.ts` + `index.html`). The polish-plan visual investment is preserved in full.

---

## Tokens shared between both stylesheets

These tokens existed in both source files with **identical or near-identical** values. Production values win (they were tuned for contrast and dark-mode parity across the polish-plan iterations).

| Token | Production (HEAD) | Demo | Resolution | Rationale |
|---|---|---|---|---|
| `--bg` (light) | `#f6f7f9` | `#f6f7f9` | Production | Identical. |
| `--fg` (light) | `#1a1a1c` | `#1a1a1c` | Production | Identical. |
| `--muted` (light) | `#6b6b73` | `#6b6b73` | Production | Identical. |
| `--border` (light) | `#e1e3e8` | `#e1e3e8` | Production | Identical. |
| `--card-bg` (light) | `#ffffff` | `#ffffff` | Production | Identical. |
| `--card-shadow` (light) | `0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.03)` | Same | Production | Identical. |
| `--accent` (light) | `#3361ff` | `#3361ff` | Production | Identical. |
| `--bg` (dark) | `#0f1115` | `#0f1115` | Production | Identical. |
| `--fg` (dark) | `#e6e8eb` | `#e6e8eb` | Production | Identical. |
| `--accent` (dark) | `#6b8aff` | `#6b8aff` | Production | Identical. |

---

## Tokens unique to production styles.css (polish-plan additions; all carried into hud-next)

These were introduced by the polish plan (U1–U5) and didn't exist in the demo. Carried verbatim.

| Token | Light | Dark | Plan ref | Notes |
|---|---|---|---|---|
| `--src-github` | `#1f5fbf` | `#6b8aff` | polish U3 | Source-chip palette, internal convention not brand. |
| `--src-jira` | `#0b5fc7` | `#5cc8ff` | polish U3 | Same. |
| `--src-slack` | `#b8463a` | `#ff9080` | polish U3 | Same. |
| `--src-code` | `#6f42c1` | `#c792ea` | polish U3 | Same. |
| `--src-default` | `#4a4a55` | `#a8aeb8` | polish U3 | Unknown-source fallback. |
| `--synthesis-tint` | `rgba(51,97,255,0.04)` | `rgba(107,138,255,0.06)` | polish U4 | Layered via `background-image: linear-gradient(tint, tint)` over `var(--card-bg)`. |
| `--pinned-bg` | `#fff8e0` | `#2a2614` | pre-polish | Pinned-section accent. |
| `--provisional-bg` | `#f0f0f5` | `#1a1a25` | pre-polish | Question-provisional cards. |
| `--gap-fg` | `#b35200` | `#ffb070` | pre-polish | Gap card title color. |
| `--error` | `#b30000` | `#ff6b6b` | pre-polish | Banner + status-live. |
| `--code-bg`, `--code-fg` | varies | varies | pre-polish | Code-block surface. |
| `--location-bg`, `--location-fg` | varies | varies | pre-polish | Code snippet location pill. |
| `--syn-*` (Prism tokens) | 13 entries | 13 entries | pre-polish | Syntax highlighting palette. |

---

## Demo-only constructs explicitly rejected

| Construct | Demo intent | Rejection reason |
|---|---|---|
| `.upwell-hud { … }` wrapper scoping | Scope all HUD styles under a single class so the marketing page can host the demo alongside other content | The hud-next app's `<body>` IS the HUD; no need for scoping. Bare selectors match production. |
| `@media (prefers-reduced-motion: reduce) { .upwell-hud .status-live::before { animation: none; } }` | Suppress all motion uniformly under reduced-motion | **Killed the connection-down signal.** Polish-plan U1 property-targeted block re-enables `.status-live::before` with `!important`. Production wins. |
| `synthesis-reveal` grid 0fr→1fr expand wrapper | Smooth reveal of synthesis card body | New behavior not in production; out of scope per "no new behavior" plan constraint. |
| `card-collapse` exit animation | Animate cards out on retraction | New behavior; the production HUD removes elements without exit animation. Out of scope. |
| `sources-in` cascade animation for consolidated sources | Stagger the appearance of consolidated source cards | New behavior; out of scope. |

---

## prefers-reduced-motion resolution (load-bearing)

**Two reduced-motion mechanisms collided.** The production rule re-enables `.status-live::before { animation: pulse 1.6s ease-in-out infinite !important }`; the demo rule did `.upwell-hud .status-live::before { animation: none }`. If the demo's block had been carried over and loaded after production's, the `!important` on production would have lost the cascade because the demo rule has higher specificity (`.upwell-hud .status-live::before` beats `.status-live::before`).

**Production block kept; demo block dropped entirely.** The reduced-motion rule in `apps/hud-next/app/styles.css` is:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .status-live::before {
    animation: pulse 1.6s ease-in-out infinite !important;
  }
}
```

The connection-down indicator survives reduced-motion — by design.

---

## What U2 actually changed in apps/hud-next/app/styles.css

**Net diff from production HEAD:** one line.

```diff
- @source "./*.ts";
- @source "../index.html";
+ @source "./**/*.{ts,tsx}";
```

Tailwind v4 needs to scan `.tsx` files (not `.ts`) for utility classes; the path is now relative to `apps/hud-next/app/`. Everything else is byte-for-byte identical to production.
