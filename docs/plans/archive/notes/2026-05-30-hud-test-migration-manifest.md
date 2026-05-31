# HUD Test Migration Manifest

**Plan:** [docs/plans/2026-05-30-001-feat-hud-nextjs-conversion-plan.md](../2026-05-30-001-feat-hud-nextjs-conversion-plan.md) — U1 deliverable, binding contract for U4 "equivalent coverage."

**Total existing tests:** 61 (53 in `apps/hud/test/sidebar.test.ts` + 8 in `apps/hud/test/ws-client.test.ts`)

**Rule:** U4 cannot ship until every row below has either a Successor test target (`apps/hud-next/test/...`) covering equivalent assertions OR an explicit `WONTFIX: <reason>` rationale.

---

## `apps/hud/test/sidebar.test.ts` (53 tests)

| # | Line | Source test name | Successor target | Notes |
|---|---|---|---|---|
| 1 | 61 | renders new cards above older ones (newest-first) | `card-stream.test.tsx` | newest-first ordering |
| 2 | 72 | cardUpdated changes score and triggeredBy in place | `card-stream.test.tsx` | reducer + render |
| 3 | 81 | cardRetracted removes the card | `card-stream.test.tsx` | reducer + render |
| 4 | 89 | pin moves card to pinned section and remains visible across 50 more cards | `pinned-section.test.tsx` | + reducer state for pinned |
| 5 | 102 | renderCard with provisional triggeredBy applies the provisional class | `card-stream.test.tsx` | `.provisional` class |
| 6 | 107 | renderCard with missing snippet renders a placeholder, not a crash | `card-stream.test.tsx` | edge case |
| 7 | 114 | renderGap renders a gap card with question and log/dismiss actions | `card-stream.test.tsx` | (or `gap.test.tsx` if extracted) |
| 8 | 122 | dismiss button removes a gap from the DOM | `card-stream.test.tsx` | reducer + render |
| 9 | 132 | renderCard with duplicate cardId is a no-op (no duplicates) | `card-stream.test.tsx` | reducer idempotency |
| 10 | 162 | synthesisStart prepends a synthesis card above raw cards with aria-live=off | `synthesis-stream.test.tsx` | aria-live="off" on body |
| 11 | 174 | appendSynthesisDelta accumulates text via textContent (no innerHTML rewrite) | `synthesis-stream.test.tsx` | XSS safety |
| 12 | 187 | eagerly renders citation chips per [N] token as deltas arrive | `synthesis-stream.test.tsx` | per-delta chip parsing |
| 13 | 197 | out-of-range [N] citations do NOT render chips (only sourceCardIds.length valid) | `synthesis-stream.test.tsx` | bounds check |
| 14 | 205 | finalizeSynthesis removes cursor, reconciles chips, announces final text | `synthesis-stream.test.tsx` + `synthesis-announce.test.tsx` | split across two |
| 15 | 227 | finalizeSynthesis strips invalid [0] tokens the synthesizer may emit | `synthesis-stream.test.tsx` | token-cleaning |
| 16 | 236 | citation chip click scrolls the matching raw card into view | `citation-chip.test.tsx` | NET-NEW component |
| 17 | 253 | removeSynthesis drops the card silently (used by both error and retract paths) | `synthesis-stream.test.tsx` | reducer + render |
| 18 | 261 | retractSynthesis is equivalent to removeSynthesis | `synthesis-stream.test.tsx` | reducer path |
| 19 | 267 | appendSynthesisDelta on an unknown synthesisId is a no-op (no card created) | `app-state.test.ts` (reducer) | reducer no-op |
| 20 | 272 | handles two concurrent syntheses with distinct ids correctly | `synthesis-stream.test.tsx` | multi-synthesis state |
| 21 | 293 | shows the empty-state placeholder when the stream has no content | `empty-state.test.tsx` | |
| 22 | 299 | hides the empty-state placeholder when a card arrives, restores when all cards are gone | `empty-state.test.tsx` | toggle on state changes |
| 23 | 312 | finalizeSynthesis moves source cards from the stream into a sources grid inside the synthesis card | `synthesis-stream.test.tsx` | consolidation |
| 24 | 337 | removeSynthesis after consolidation restores the raw cards to the stream | `synthesis-stream.test.tsx` | deconsolidation |
| 25 | 353 | pinned cards are NOT consolidated (they stay in the pinned section) | `synthesis-stream.test.tsx` | interaction with pinned-section |
| 26 | 376 | scrolls the stream to top when a new card arrives and mouse is NOT over the stream | `hud-shell.test.tsx` | hover-safe scroll |
| 27 | 385 | does NOT scroll while hovering. shows pulsing badge with new count | `hud-shell.test.tsx` | badge logic |
| 28 | 399 | mouseleave with pending new content scrolls to top and hides the badge | `hud-shell.test.tsx` | flush on mouseleave |
| 29 | 415 | badge click flushes pending state and scrolls to top | `hud-shell.test.tsx` | flush on click |
| 30 | 428 | synthesis card render counts toward the pending new-content total too | `hud-shell.test.tsx` | counter increment |
| 31 | 435 | synthesisError after deltas does NOT consolidate (raw cards stay in stream) | `synthesis-stream.test.tsx` | error path |
| 32 | 453 | renderCard adds is-entering on the new card element | `card-stream.test.tsx` | entry animation class |
| 33 | 460 | renderSynthesisStart adds is-entering on the synthesis card | `synthesis-stream.test.tsx` | shared animation language |
| 34 | 471 | renderGap adds is-entering on the gap element | `card-stream.test.tsx` | gap entry animation |
| 35 | 478 | dispatching animationend removes is-entering | `card-stream.test.tsx` | animationend cleanup |
| 36 | 486 | setTimeout safety net removes is-entering when animationend never fires | `card-stream.test.tsx` | belt-and-suspenders |
| 37 | 501 | idempotent cleanup — animationend + setTimeout both firing does not throw | `card-stream.test.tsx` | double-cleanup safety |
| 38 | 517 | subsequent renderCard does NOT re-add is-entering on the previous card | `card-stream.test.tsx` | regression guard |
| 39 | 536 | github + issue renders chip-source-github and chip-type-issue | `hud-card.test.tsx` | chip render |
| 40 | 546 | jira + pull-request renders chip-source-jira and codePullRequest glyph | `hud-card.test.tsx` | chip render |
| 41 | 555 | type chip carries aria-label on the glyph wrapper for screen readers | `hud-card.test.tsx` | a11y assertion (note: U2 modifies glyphs.tsx for this — see plan) |
| 42 | 562 | unknown source falls back to chip-source-default | `hud-card.test.tsx` | fallback |
| 43 | 568 | unknown type renders empty chip-type-unknown (hidden via CSS) | `hud-card.test.tsx` | fallback |
| 44 | 575 | code type uses the code glyph and shows the source-side accent | `hud-card.test.tsx` | combo |
| 45 | 589 | (synthesis card carries data-kind="synthesis") | `synthesis-stream.test.tsx` | data-kind attribute |
| 46 | 599 | synthesis card has the synthesis class (left accent border + tint applied via CSS) | `synthesis-stream.test.tsx` | class presence |
| 47 | 612 | synthesis-body uses the .synthesis-body class so the larger answer-text rule applies | `synthesis-stream.test.tsx` | class presence |
| 48 | 646 | citation chip is a `<button>` element (keyboard-focusable, Enter/Space activate) | `citation-chip.test.tsx` | NET-NEW component |
| 49 | 652 | citation chip title equals the source card title (hover preview) | `citation-chip.test.tsx` | NET-NEW component |
| 50 | 657 | clicking adds is-cited-target to the target card and removes it after the timeout | `citation-chip.test.tsx` | cite-pulse |
| 51 | 673 | retracted source: click does not throw, marks chip retracted, updates title | `citation-chip.test.tsx` | retracted UX |
| 52 | 684 | target already in view: pulse still applies even if scrollIntoView is a no-op | `citation-chip.test.tsx` | semantic |
| 53 | 701 | keyboard activation via Enter dispatches the same handler as click (native button behavior) | `citation-chip.test.tsx` | keyboard a11y |

---

## `apps/hud/test/ws-client.test.ts` (8 tests)

| # | Line | Source test name | Successor target | Notes |
|---|---|---|---|---|
| 54 | 27 | sends ?token= in the URL | `use-upwell-socket.test.ts` | URL construction |
| 55 | 43 | appends &token= when the URL already has query parameters | `use-upwell-socket.test.ts` | URL construction |
| 56 | 59 | emits status: connecting → open on a successful open | `use-upwell-socket.test.ts` | hook status state |
| 57 | 81 | parses JSON server messages and forwards them to onMessage | `use-upwell-socket.test.ts` + `app-state.test.ts` | hook + reducer dispatch |
| 58 | 101 | ignores non-string and malformed messages | `use-upwell-socket.test.ts` | error tolerance |
| 59 | 120 | schedules a reconnect after onclose | `use-upwell-socket.test.ts` | backoff |
| 60 | 143 | forces an immediate reconnect when document becomes visible | `use-upwell-socket.test.ts` | visibility-driven reconnect |
| 61 | 174 | stop() prevents reconnect | `use-upwell-socket.test.ts` | hook cleanup |

---

## New tests required (not derived from existing — net-new behavior)

- `use-upwell-socket.test.ts` — StrictMode double-mount/unmount produces no duplicate event dispatches.
- `app-state.test.ts` — reducer handles each WS message type cleanly (8 cases).
- `theme-toggle.test.tsx` — toggles `.dark`, persists to localStorage, falls back gracefully when localStorage throws.
- `theme-toggle.test.tsx` — inline-script SHA-256 hash is stable across builds (deterministic; verified by reading the hash file at runtime).
- `synthesis-announce.test.tsx` — sr-only aria-live="polite" region updated ONLY on synthesisDone.

---

## Notes

- **Em-dash scrubbing** (line absent from original sidebar tests) was a phantom feature; removed from the plan's R6. No corresponding test exists or is needed.
- **Test framework:** vitest + happy-dom + @testing-library/react in `apps/hud-next/test/`. Pattern mirrors `apps/web/test/` in the landing-page repo.
- **`apps/hud-next/test/` tests run via `pnpm --filter @upwell/hud-next test`** which integrates with the workspace `pnpm -w test` command.
