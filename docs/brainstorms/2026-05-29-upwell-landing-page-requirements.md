---
date: 2026-05-29
topic: upwell-landing-page
status: ready-for-planning
---

# Upwell Landing Page

## Problem Frame

Upwell has no public presence. We need a clean, professional marketing site that
explains what Upwell is and makes the product *feel real* through a faithful demo,
before the product itself is broadly available (early-dev, Linux-only). The site
must be built so a customer portal can hang off it later — the landing page is the
first surface of a larger web app, not a throwaway one-pager.

The hardest part of marketing this product is that its core behavior — context
*surfacing itself* during a live meeting — is hard to convey in static copy. The
page's job is to *show* it: a meeting playing out, transcript streaming, and cards
appearing the moment they're relevant. The demo carries the pitch.

## Lead Positioning

**Proactive surfacing** is the lead angle: *context finds you — no querying, no
bot, no asking.* Answers and sources appear the moment they matter. This is the
wedge versus query-on-demand tools (Glean, M365 Copilot) and post-meeting
transcribers (Otter, Granola, Fireflies).

Secondary beats, in priority order:
1. **Local-first & private** — runs entirely on your machine; no bot joins the
   call; audio never leaves your laptop.
2. **Multi-source grounding** — cards pull from GitHub, Jira, and Slack.
3. **Closes the doc gap** — captures questions the knowledge base couldn't answer
   and feeds them back into docs/tickets.

## Actors

- **Prospective user / evaluator** — an engineer, EM, or eng-adjacent lead landing
  on the page. Wants to understand in seconds what Upwell does and whether it's
  worth their time. Primary action: request early access.

## Key Flows

- **F1. Land → understand → watch the demo → request access**
  - Visitor arrives at the hero, reads the proactive-surfacing headline.
  - Scrolls to the looping demo; watches a simulated meeting surface cards and a
    cited synthesis answer on its own.
  - Reads the supporting value sections (local-first, multi-source, doc-gap loop).
  - Submits the early-access form (or clicks the primary CTA).
  - **Outcome:** visitor grasps the product and converts to a waitlist signup.

## Requirements

**Site shell & structure**
- R1. Built with Next.js (App Router) and Tailwind CSS, structured so a customer
  portal can be added later without re-architecting (routing, layout, and shared
  UI anticipate authenticated routes).
- R2. Lives as a new app in this pnpm monorepo (default: `apps/web`), consistent
  with existing workspace conventions (TS strict, kebab-case files).
- R3. Responsive and accessible: works on mobile and desktop; respects reduced-
  motion preferences (the demo must degrade gracefully when motion is reduced).
- R4. Light/dark aware, reusing the HUD's visual language — accent `#3361ff`,
  source-chip palette, system font stack, subtle card borders/shadows.

**Page content**
- R5. Hero section leading with proactive surfacing: headline, one-line
  subhead, and the primary early-access CTA.
- R6. A short "how it works" / value sequence covering the secondary beats
  (local-first/private, multi-source grounding, doc-gap feedback loop) — concise,
  scannable, professional. No filler marketing slop.
- R7. The simulated-meeting demo as the visual centerpiece (see below).
- R8. A footer with minimal links (e.g., product status / "early development",
  contact). No pricing, blog, or docs in this version.

**The simulated-meeting demo (centerpiece)**
- R9. An **auto-playing, looping** scripted scene — no playback controls. It plays
  on its own and loops (~20–30s cycle). Should begin when scrolled into view.
- R10. **Pixel-faithful to the real HUD.** Reproduce the genuine UI, not a stylized
  cartoon. Specifically:
  - A header with the **LIVE** badge (red dot) and a status indicator.
  - A streaming transcript: speaker-attributed lines appearing/typing in,
    including at least one detected question ("what's the status of the auth
    migration PR?").
  - **RAG cards** sliding into the sidebar as relevance hits, matching the real
    card: `SOURCE · TYPE` chip header (e.g. `GITHUB · DOC`), a `TOP MATCH` /
    `MATCH` label (top match in accent), bold underlined title, a muted
    doc-heading line, a snippet, and a `Pin` action.
  - An **AI Summary card**: the blue `AI SUMMARY` pill, an answer that types out
    with inline `[1]`-style citation markers, a citation chip, and a
    `SOURCES (n)` list of source cards.
- R11. Driven by **canned/simulated data on a fixed timeline** — self-contained,
  not wired to the real daemon, WebSocket, or any backend. The scene is scripted
  to look like a believable engineering standup.
- R12. Card source chips in the demo use the real source colors (GitHub, Jira,
  Slack, code) from the HUD palette so the demo and product read as one product.

**Early-access CTA**
- R13. Primary CTA is an early-access / waitlist signup (not a download), framed
  for an early-dev, Linux-only product.
- R14. The form is **presentation-only** in this version — visual + client-side
  validation, no real email capture or backend wiring. (Wiring it to a real
  backend is deferred; see Scope Boundaries.)

## Success Criteria

- A visitor unfamiliar with Upwell can, within ~30 seconds, state what it does:
  "it surfaces context during meetings, on its own."
- The demo is immediately legible as *the actual product*, not a generic mockup —
  someone who has seen the HUD recognizes it.
- The page reads as clean and professional (no AI-slop hero copy, no clutter),
  and renders correctly in light and dark, on mobile and desktop.
- Adding a customer portal later does not require restructuring the site shell.

## Scope Boundaries

**In scope**
- Single landing page (hero, value sections, demo, CTA, footer).
- Auto-playing looping demo faithful to the HUD, with simulated data.
- Next.js + Tailwind shell ready for future authenticated routes.

**Deferred for later**
- Customer portal, authentication, and any authenticated routes.
- A real waitlist backend / email capture / CRM integration.
- Pricing, blog, docs, changelog, multi-page marketing.
- macOS/Windows availability messaging (Linux-only at launch).
- Wiring the demo to the real daemon or live data.

**Outside this product's identity**
- The demo must never misrepresent the product (e.g., implying cloud processing,
  a meeting bot, or platforms not yet supported). Local-first and no-bot are
  load-bearing claims.

## Dependencies / Assumptions

- **Assumption:** the site lives at `apps/web` in this monorepo (App Router). If a
  separate repo is preferred, R2 changes but nothing else does.
- **Assumption:** reuse of the HUD's existing visual tokens (accent, source-chip
  colors, fonts) is desired for brand cohesion. Source of truth:
  `apps/hud/src/styles.css`.
- **Assumption:** the waitlist form is non-functional (presentation-only) for now.
- **Reference:** real card/synthesis shapes live in `apps/hud/src/types.ts`,
  `apps/hud/src/sidebar.ts`, and `apps/hud/src/styles.css`. Product framing in
  `docs/brainstorms/meeting-context-copilot-requirements.md`.
- **No verified dependency** on the daemon or any running service — the demo is
  self-contained.

## Open Questions (for planning)

- Exact monorepo wiring: Next.js version, where shared types/UI live, how `apps/web`
  fits the existing TS project-references and build pipeline.
- Whether the demo is implemented as a hand-built React animation, a CSS/keyframe
  timeline, or a small scripted state machine — an implementation choice for `ce-plan`.
- Final hero copy and the exact scripted transcript/cards for the demo scene.
