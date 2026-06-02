---
title: "feat: Live meeting surfaces — upcoming liveness, live transcript, review rework"
status: completed
date: 2026-06-01
type: feat
---

# feat: Live meeting surfaces — upcoming liveness, live transcript, review rework

## Summary

Three meeting surfaces need to feel live and consistent. The **Upcoming** page must reflect bot-join / meeting-live transitions without a manual refresh. The **live meeting** page must add a running transcript (transcript left, AI Summary cards right) with speaker names, on top of the Realtime fixes already landed on this branch. The **Review** page must be reworked to mirror the live experience: a generated whole-meeting recap, the full transcript, and the same polished synthesis cards — with each synthesis anchored inline in the transcript at the point it was generated (highlighted; click opens the card).

The transcript data already flows end-to-end (`transcript.data` / `transcript.partial_data` events carry `text` + `speaker` and are persisted to `meeting_events` + broadcast over Realtime) — the live page's reducer simply **drops** them today. So the bulk of the new work is portal/UI plus one async recap-generation step and a small synthesis→utterance link.

---

## Problem Frame

The live meeting pipeline (Recall → bot-worker → `meeting_events` → Realtime → portal) is functional after this branch's Realtime-auth + reducer-replay fixes, but the three meeting-facing pages are incomplete:

- **Upcoming** (`apps/portal/app/(authed)/upcoming/page.tsx`) is fully server-rendered with no client liveness — bot status is frozen at page load and only advances on a manual refresh.
- **Live** (`apps/portal/app/(authed)/meetings/[meetingId]/live/_client.tsx`) renders only the AI Summary (synthesis) feed. There is no transcript, even though every utterance is already broadcast and persisted. Users can't see what was heard or who said it.
- **Review** (`apps/portal/app/(authed)/meetings/[meetingId]/review/page.tsx`) is a static, plainer surface that lists "SYNTHESES" and "SURFACED CARDS" with an older synthesis shape (`citations: number[]`), no transcript, and no meeting-level summary. It does not match the live view.

Speaker attribution is available with zero bot-worker work: `adaptRecallMessage` sets `Utterance.speaker` from `participant.name` (`apps/bot-worker/src/recall-adapter.ts`), and `utteranceToEventPayload` already includes `speaker` in the broadcast/persisted payload (`apps/bot-worker/src/db.ts`).

---

## Requirements

- **R1.** The Upcoming page reflects meeting status transitions (launching → awaiting_recall → joining → waiting_room → recording → completed) within a few seconds, without a manual refresh, while the page is open.
- **R2.** The live meeting page reliably reflects bot-join → live transitions live (joining shell → recording HUD) — verify and harden on top of the Realtime fixes already on this branch.
- **R3.** The live meeting page shows a running transcript in a two-column layout: transcript on the left, AI Summary cards on the right.
- **R4.** The transcript shows who is speaking (speaker name) alongside the transcribed text, with partial utterances updating in place and finals settling.
- **R5.** The transcript survives page reload and Realtime reconnect (seeded from the durable `meeting_events` record, then kept live), consistent with how cards/syntheses already hydrate.
- **R6.** The Review page renders a generated whole-meeting AI recap, the full transcript, and the meeting's synthesis cards using the same styling as the live view.
- **R7.** On the Review page, each synthesis is anchored inline in the transcript at the utterance that triggered it: the spot is highlighted, and clicking it surfaces that synthesis card.
- **R8.** The Review-page synthesis cards render correctly regardless of the citation shape stored on the row (no reliance on the deprecated `citations: number[]` rendering).

---

## Key Technical Decisions

- **KTD1 — Upcoming liveness via lightweight polling.** A small client component polls meeting statuses every few seconds while the page is open and patches changed rows. Chosen over Realtime: the Upcoming page is a *list* of meetings, so a Realtime approach needs either many private channels or a new org-level status topic + RLS — disproportionate for a status string that changes a handful of times per meeting. Polling is the pattern the live page already uses as its status fallback (`apps/portal/app/_lib/realtime-meeting-channel.ts`).
- **KTD2 — Transcript state lives in the shared hud-ui reducer.** Add transcript utterances to `AppState` and handle `transcript.data` / `transcript.partial_data` as reducer actions, rather than local component state (the shape the debug live-mic page uses). Rationale: the live page already drives cards + syntheses through the reducer + Realtime + SSR-seed + reconnect-replay path; routing transcript through the same path gives reload/reconnect durability (R5) for free and keeps one source of truth. The reducer must be replay-idempotent (merge partial→final by `utteranceId`, last-revision-wins) — consistent with the S6 guards added on this branch.
- **KTD3 — Speaker labels from Recall participant names.** Use the `speaker` already on the transcript payload. No diarization fallback in scope; when `speaker` is null (rare/unknown participant) the transcript renders the text under an "Unknown speaker" group.
- **KTD4 — Live right column is unchanged.** The AI Summary (synthesis) feed stays exactly as-is; the only live-page change is wrapping it in a two-column shell with the new transcript on the left. No raw source-card stream is added to the live page.
- **KTD5 — Meeting recap generated async on meeting end.** When a meeting reaches `completed` (the `bot.call_ended` path that already pings the bot-worker to flush), enqueue an Inngest function that reads the full transcript from `meeting_events`, calls Claude once for a whole-meeting recap, and persists it. The Review page shows a "generating…" state until ready. Rationale: a full-transcript summarization is too slow for request-time rendering and benefits from Inngest's retry/observability, matching the existing indexer/calendar-sync functions in `apps/portal/src/inngest/functions/`.
- **KTD6 — Synthesis↔transcript anchoring via a stored trigger utterance.** Add `trigger_utterance_id` to `syntheses`, written by the bot-worker at synthesis time (it already holds the triggering utterance context). The Review page maps `utterance_id → synthesis` to place inline markers. Fallback when null: derive via `synthesis.source_card_ids → cards.utterance_id`, so historical rows still anchor.
- **KTD7 — Transcript source of truth is `meeting_events`.** Finals = `transcript.data`; the live page seeds prior finals on SSR and replays on reconnect; the Review page reads the full ordered set. No new transcript table.

---

## High-Level Technical Design

Data flow across the three surfaces. Bold nodes are new or changed by this plan.

```mermaid
flowchart TD
  Recall[Recall bot audio] --> BW[bot-worker]
  BW -->|transcript.data / partial_data\n+ card / synthesis events| ME[(meeting_events)]
  BW -->|status flip| MT[(meetings.status)]
  BW -. trigger_utterance_id .-> SY[(syntheses)]

  ME -->|Realtime broadcast| RT{{Realtime channel\nmeeting:org:meeting}}
  ME -->|SSR seed + reconnect-fetch| SSR[portal server fetch]

  RT --> HOOK[useRealtimeMeetingChannel]
  SSR --> HOOK
  HOOK -->|dispatch: transcript / card / synthesis / status| RED[[hud-ui AppState reducer\n+ transcript state]]
  RED --> LIVE[**Live page: transcript left | AI cards right**]

  MT -->|**poll every ~3s**| UP[**Upcoming page liveness**]

  BW -->|bot.call_ended → completed| WH[recall webhook]
  WH -->|enqueue| ING[**Inngest: generate meeting recap**]
  ME -->|full transcript| ING
  ING -->|recap_text| MT
  MT --> REV[**Review page**]
  ME --> REV
  SY --> REV
  REV --> REVUI[**recap + transcript w/ inline synthesis markers + live-styled cards**]
```

---

## Scope Boundaries

**In scope:** Upcoming status liveness (polling); live two-column layout + running transcript with speakers; transcript reducer state + durability; review-page rework (recap + transcript + anchored synthesis cards); the `trigger_utterance_id` link; async recap generation.

**Out of scope (non-goals):**
- Changing the retrieval/synthesis pipeline, relevance gating, or skills.
- Transcript editing, correction, search, or export.
- Participant join/leave timelines or a presence/speaker bar (the bot-worker already notes this as deferred in `apps/bot-worker/src/index.ts`).
- Speaker **diarization** beyond Recall's per-participant attribution.
- Realtime (vs polling) for the Upcoming list.

### Deferred to Follow-Up Work
- A "show dismissed" toggle for retracted cards/syntheses on Review (already noted as deferred in the current review page).
- Backfilling `trigger_utterance_id` for pre-existing syntheses (the derive-from-cards fallback covers them at render time).
- Recap regeneration / editing controls.
- Transcript virtualization for very long meetings (see Risks).

---

## Implementation Units

### U1. Upcoming page live status (polling)

**Goal:** Meeting rows on `/upcoming` advance through their lifecycle without a manual refresh.

**Requirements:** R1.

**Dependencies:** none.

**Files:**
- `apps/portal/app/(authed)/upcoming/page.tsx` (modify — render a client liveness wrapper around the meeting rows)
- `apps/portal/app/(authed)/upcoming/_live-status.tsx` (create — `'use client'` poller)
- `apps/portal/app/(authed)/upcoming/_live-status.test.tsx` (create)

**Approach:** A client component receives the server-rendered meetings (id + initial status) and polls `meetings.status` (+ `recall_bot_id`) for the org's active meetings on an interval while mounted, patching any row whose status changed and updating its label/CTA (e.g. "Bot launching…" → "Bot joining…" → "Join / View meeting" when recording). Reuse the status→label mapping the live page's `JoiningShell` already encodes so wording stays consistent. Stop/skip polling for terminal statuses (`completed`/`failed`). Use the browser Supabase client (RLS-scoped) for the read.

**Patterns to follow:** the status-poll effect in `apps/portal/app/_lib/realtime-meeting-channel.ts` (interval, cleanup, `maybeSingle`/`select` shape); `_sync-status.tsx` for the existing client-component-in-upcoming pattern.

**Test scenarios:**
- A meeting seeded as `launching` whose status becomes `recording` updates its label/CTA to the recording state after a poll tick (fake timers + mocked client). *Covers R1.*
- A meeting at a terminal status (`completed`) is not polled / shows the review CTA.
- Cleanup: unmounting clears the interval (no post-unmount state updates).
- Multiple meetings: only the changed row re-renders to its new state; others unchanged.

**Verification:** Open `/upcoming` while a bot launches; rows advance to "live" within a few seconds with no refresh.

---

### U2. Live page status-transition liveness (verify + harden)

**Goal:** The live page reliably swaps joining-shell → recording-HUD as the bot dials in, live.

**Requirements:** R2.

**Dependencies:** none (builds on Realtime-auth + reducer fixes already on this branch).

**Files:**
- `apps/portal/app/(authed)/meetings/[meetingId]/live/_client.tsx` (modify only if a gap is found)
- `apps/portal/app/_lib/realtime-meeting-channel.ts` (modify only if a gap is found)

**Approach:** Primarily a verification unit. The Realtime channel now authorizes (fixed this branch) and delivers `meetingStatus`; the 3s status poll is the backstop. Confirm the joining→recording transition fires from a live `meetingStatus` broadcast (not only the poll), and that `effectiveStatus` resolves correctly when the broadcast and poll race. Only change code if the transition is found to lag or flicker.

**Test scenarios:**
- A `meetingStatus` broadcast with `status: 'recording'` flips `liveMeetingStatus` and renders the recording shell (extend existing `realtime-meeting-channel` coverage if present; otherwise add a focused test).
- Poll and broadcast both reporting `recording` do not double-toggle the shell.

**Verification:** Bot joins a live meeting; the page swaps to the HUD without a manual refresh.

---

### U3. Transcript state in the hud-ui reducer

**Goal:** Transcript utterances become first-class reducer state, fed by the Realtime channel (which currently drops them).

**Requirements:** R3, R4, R5.

**Dependencies:** none.

**Files:**
- `packages/hud-ui/src/state/app-state.tsx` (modify — add `transcript` to `AppState`, add `transcriptUtterance` action(s), reducer cases)
- `packages/hud-ui/src/types.ts` (modify — `TranscriptUtterance` type: `utteranceId, text, speaker | null, isFinal, startMs, revision`)
- `packages/hud-ui/src/index.ts` (modify — export the new type/selectors)
- `apps/portal/app/_lib/realtime-meeting-channel.ts` (modify — map `transcript.data` / `transcript.partial_data` broadcasts to the new dispatch instead of the current no-op)
- `packages/hud-ui/test/app-state.test.ts` (modify — add transcript reducer tests)

**Approach:** Store utterances in insertion/`startMs` order keyed by `utteranceId`. A partial and its later final share the same `utteranceId` (Recall identity = `participantId::startMs`); the reducer merges by id with last-`revision`-wins, so a final replaces its partial in place and a stale/replayed revision is ignored (replay-idempotent, matching the S6 guards on this branch). Wire `dispatchBroadcast` in `realtime-meeting-channel.ts` to translate both transcript event types (today an explicit no-op) into the reducer action; the `eventId` high-water-mark logic already there continues to apply.

**Patterns to follow:** the partial→final merge in `apps/portal/app/(authed)/debug/live-mic/_client.tsx` (`findIndex` by `utteranceId`, replace newer revision); the existing `card`/`synthesis` reducer cases for clone-map + idempotency style.

**Test scenarios:**
- A partial then a final with the same `utteranceId` results in one utterance, `isFinal: true`, text = the final's. *Covers R4.*
- A replayed (older `revision`) update for an already-final utterance is ignored (idempotent under reconnect replay). *Covers R5.*
- Two utterances with different `utteranceId`s both appear, in `startMs` order.
- An utterance with `speaker: null` is retained and exposed as unknown-speaker.

**Verification:** Reducer unit tests pass; transcript events dispatched through the channel land in state.

---

### U4. Transcript panel component (hud-ui)

**Goal:** A presentational transcript that renders utterances grouped by speaker, with partial vs final affordance.

**Requirements:** R3, R4.

**Dependencies:** U3.

**Files:**
- `packages/hud-ui/src/components/transcript-panel.tsx` (create)
- `packages/hud-ui/src/index.ts` (modify — export)
- `packages/hud-ui/src/styles.css` (modify — transcript + speaker styles, theme-aware tokens)
- `packages/hud-ui/test/transcript-panel.test.tsx` (create)

**Approach:** Reads transcript state via the app-state context (like `SynthesisStream`). Groups consecutive utterances by the same `speaker` under a single speaker label; renders each utterance's text, with the in-flight partial styled distinctly (muted / cursor) and finals settled. Auto-scroll to the newest utterance unless the user has scrolled up (standard "stick to bottom" behavior). Accepts an optional render hook/slot for inline markers so U8's review variant can inject synthesis anchors without forking the component (see U8).

**Patterns to follow:** `SynthesisStream` (context read + map), `card-bits.tsx` (chip/label styling), the theme-token approach used for `--synthesis-shadow` on this branch (no hardcoded light/dark colors).

**Test scenarios:**
- Consecutive utterances from the same speaker render under one speaker heading; a speaker change starts a new group. *Covers R4.*
- A partial utterance renders with the partial affordance; once final, the affordance clears.
- Empty transcript renders an empty/idle state, not a crash.
- `speaker: null` renders under an "Unknown" group.

**Verification:** Component tests pass; visually shows grouped, speaker-attributed transcript.

---

### U5. Live page two-column layout + transcript hydration

**Goal:** The live recording view becomes transcript-left / AI-cards-right, with the transcript seeded on load and kept live.

**Requirements:** R3, R5.

**Dependencies:** U3, U4.

**Files:**
- `apps/portal/app/(authed)/meetings/[meetingId]/live/_client.tsx` (modify — `RecordingShell` two-column layout; mount `TranscriptPanel`)
- `apps/portal/app/(authed)/meetings/[meetingId]/live/page.tsx` (modify — SSR-seed prior finals from `meeting_events`)
- `apps/portal/app/(authed)/meetings/[meetingId]/live/_client.test.tsx` (create or extend — seeding + layout)

**Approach:** `RecordingShell` gains a responsive two-column container: left = `TranscriptPanel`, right = the existing `PinnedSynthesesSection` + `SynthesisStream` (unchanged content, KTD4). The server component fetches prior `transcript.data` rows for the meeting and seeds them into the reducer's initial state (same seeding mechanism as `initialCards`/`initialSyntheses`); the live channel + reconnect-replay then keep it current (R5). Keep the existing scroll-gutter fix. On narrow viewports, stack (transcript above cards) — confirm responsive behavior.

**Patterns to follow:** the `seedState` + `initialCards`/`initialSyntheses` flow in `live/_client.tsx` and `live/page.tsx`; the `min-h-0 flex-1 overflow-y-auto` scroll container already there.

**Test scenarios:**
- Server-seeded prior finals appear in the transcript on first render (no live events yet). *Covers R5.*
- A `transcript.data` broadcast after mount appends to the seeded transcript without duplicating a seeded utterance (idempotent merge). *Covers R5.*
- Layout: recording shell renders both columns; the right column still shows the synthesis feed unchanged (regression guard for KTD4).

**Verification:** Join a live meeting, speak; transcript streams on the left with speakers, AI cards continue on the right; reload mid-meeting restores the transcript.

---

### U6. Anchor syntheses to the triggering utterance

**Goal:** Persist which transcript utterance triggered each synthesis, so Review can place inline markers.

**Requirements:** R7.

**Dependencies:** none (can land in parallel with U3–U5).

**Files:**
- `supabase/migrations/<timestamp>_syntheses_trigger_utterance.sql` (create — add nullable `trigger_utterance_id text` to `syntheses`)
- `apps/bot-worker/src/retrieval.ts` (modify — write `trigger_utterance_id` on the synthesis row in `runSynthesisAndBroadcast`)
- `apps/bot-worker/test/...` (modify/create — assert the id is persisted on the synthesis insert/update)

**Approach:** Add the nullable column (pre-launch, additive — safe). In the synthesis path, thread the triggering utterance id (already available where retrieval fires for an utterance) onto the `syntheses` insert/update. No backfill — the Review page derives a fallback for null rows via `source_card_ids → cards.utterance_id` (KTD6).

**Execution note:** Migration is additive and nullable — no deploy-window concern; verify it lands before the bot-worker writes the column.

**Test scenarios:**
- A synthesis produced for a given utterance persists that `trigger_utterance_id`.
- A synthesis path with no clean triggering utterance leaves the column null without erroring.

**Verification:** New syntheses rows carry `trigger_utterance_id`; column is nullable and ignorable by existing readers.

---

### U7. Meeting recap generation (Inngest, on meeting end)

**Goal:** Produce a whole-meeting AI recap when a meeting completes, stored for the Review page.

**Requirements:** R6.

**Dependencies:** none (parallel with UI units; U8 consumes its output).

**Files:**
- `supabase/migrations/<timestamp>_meeting_recap.sql` (create — `recap_text text`, `recap_status text` (`pending|generating|done|failed`), `recap_generated_at timestamptz` on `meetings`)
- `apps/portal/src/inngest/functions/generate-meeting-recap.ts` (create — read full transcript from `meeting_events`, call Claude once, persist recap)
- `apps/portal/src/inngest/client.ts` (modify — register the function / event)
- `apps/portal/app/api/recall/webhook/route.ts` (modify — enqueue the recap event on the `bot.call_ended` → completed path)
- `apps/portal/src/inngest/functions/generate-meeting-recap.test.ts` (create)

**Approach:** On `bot.call_ended` (where the webhook already pings the bot-worker to flush and the meeting moves to `completed`), emit a `risezome/meeting.recap-requested` event. The function loads ordered `transcript.data` rows for the meeting, composes a single Claude call ("summarize this meeting: key topics, decisions, action items"), and writes `recap_text` + `recap_status='done'`. Mark `generating` at start and `failed` on exhausted retries so the Review page can show state. Reuse the engine's Anthropic client/synthesis settings and the existing Inngest function conventions (retries, step naming, service-role client).

**Patterns to follow:** `apps/portal/src/inngest/functions/index-trello.ts` (function shape, `step.run`, service-role client, status writes); the engine summarizer/Anthropic usage in `packages/engine/src/summarize/`.

**Test scenarios:**
- Given transcript rows, the function calls the model once and writes `recap_text` + `recap_status='done'` (model + DB mocked).
- A meeting with no transcript writes an empty/"no transcript" recap and a terminal status (no crash).
- Model/transport failure leaves `recap_status='failed'` after retries (no partial write).
- The webhook enqueues exactly one recap event on the completed transition (not on other webhook types).

**Verification:** Ending a meeting populates `meetings.recap_text` within the function's runtime; status transitions pending→generating→done observable in the DB.

---

### U8. Review page rework (recap + transcript + anchored synthesis cards)

**Goal:** The Review page mirrors the live experience: recap, full transcript with inline synthesis markers, and live-styled synthesis cards.

**Requirements:** R6, R7, R8.

**Dependencies:** U4 (transcript panel), U6 (anchor link), U7 (recap).

**Files:**
- `apps/portal/app/(authed)/meetings/[meetingId]/review/page.tsx` (modify — fetch recap + full transcript + syntheses; build utterance→synthesis index)
- `apps/portal/app/(authed)/meetings/[meetingId]/review/_client.tsx` (create — client wrapper to render hud-ui `SynthesisCard`s + the transcript with clickable markers + open-card interaction)
- `apps/portal/app/(authed)/meetings/[meetingId]/review/_client.test.tsx` (create)

**Approach:** Server fetches: `meetings.recap_*`, all `transcript.data` rows (ordered), `syntheses` (done) with `trigger_utterance_id` (fallback-derived via `source_card_ids → cards.utterance_id` when null), and the cited cards needed to render sources. Render top-to-bottom: (1) the recap (or a "generating…/unavailable" state from `recap_status`); (2) the transcript via the shared `TranscriptPanel` with inline synthesis markers injected at anchored utterances (highlighted affordance); clicking a marker opens that synthesis in the hud-ui `SynthesisCard` (modal/inline expansion). Render synthesis cards with the same `SynthesisCard` component the live view uses, normalizing citations through the existing `normalizeCitations` helper already in `live/page.tsx` so the deprecated `citations: number[]` shape renders correctly (R8). Static page — no Realtime — but reuse the live components for visual parity.

**Patterns to follow:** `normalizeCitations` + the `InitialSynthesis` mapping in `live/page.tsx`; `SynthesisCard` usage in `hud-ui`; `TranscriptPanel` render-slot from U4.

**Test scenarios:**
- A meeting with a `done` recap renders the recap text; a `generating`/`failed` recap renders the corresponding state, not a blank. *Covers R6.*
- An utterance that triggered a synthesis renders a highlighted marker; activating it surfaces that synthesis card. *Covers R7.*
- A synthesis whose `trigger_utterance_id` is null still anchors via the `source_card_ids → cards.utterance_id` fallback. *Covers R7.*
- A synthesis row stored with `citations: number[]` renders its citations correctly through `normalizeCitations`. *Covers R8.*
- A meeting with no syntheses renders the transcript + recap with no markers (no crash).

**Verification:** Open a completed meeting's review page: recap at top, full speaker-attributed transcript with clickable synthesis highlights, and synthesis cards visually identical to the live view.

---

## Risks & Dependencies

- **Transcript length / performance.** A long meeting yields hundreds–thousands of utterances. The live page seeds + streams all finals; the review page renders the full set. Risk: large DOM / slow render. Mitigation for now: group-by-speaker reduces nodes; if it bites, add windowing/virtualization (deferred). Flag rather than pre-optimize.
- **Reducer growth.** Adding transcript to `AppState` must preserve the replay-idempotency invariants that this branch's fixes established (merge-by-id, last-revision-wins) — otherwise reconnect-replay double-renders the transcript. U3's tests are the guard.
- **Recap latency + cost.** A full-transcript Claude call per meeting end. Async via Inngest keeps it off the request path; `recap_status` makes the Review page honest while it runs. Watch token cost on very long meetings (consider truncation/chunking if needed — deferred).
- **Synthesis anchor accuracy.** `trigger_utterance_id` is only as good as the utterance bound to the synthesis at generation time; the cards fallback covers historical rows but may anchor to the nearest cited utterance rather than the exact question. Acceptable for V1.
- **Speaker quality.** Recall participant names depend on the meeting platform exposing them; some participants may show generic labels. Out of scope to improve.

---

## Open Questions / Deferred to Implementation

- Exact recap prompt shape + length target (topics / decisions / action items) — resolve against the engine summarizer conventions during U7.
- Whether the recap stores structured sections (jsonb) or a single markdown blob — start with a single `recap_text` blob; revisit only if the Review UI needs structure.
- Inline-marker interaction detail (modal vs inline expand vs scroll-to-card) — resolve during U8 against the live `SynthesisCard` affordances.
- Exact migration timestamps + column defaults — execution-time.

---

## Sources & Research

- Realtime/transcript flow, reducer, and seeding: `apps/portal/app/_lib/realtime-meeting-channel.ts`, `apps/portal/app/(authed)/meetings/[meetingId]/live/{page,_client}.tsx`, `packages/hud-ui/src/state/app-state.tsx`.
- Transcript event production + speaker: `apps/bot-worker/src/{index.ts,recall-adapter.ts,db.ts}` (speaker from `participant.name`; `transcript.data`/`partial_data` payloads).
- Transcript-rendering prior art (local state, partial→final merge): `apps/portal/app/(authed)/debug/live-mic/_client.tsx`.
- Synthesis/citation rendering + normalization: `live/page.tsx` (`normalizeCitations`), `packages/hud-ui/src/components/synthesis-card.tsx`.
- Inngest function conventions: `apps/portal/src/inngest/functions/index-trello.ts`; engine summarization: `packages/engine/src/summarize/`.
- Schema: `supabase/migrations/20260602000000_meeting_events_and_artifacts.sql` (cards/syntheses/gaps; syntheses has no utterance link today — KTD6 adds it).
- This branch's prior fixes that this plan builds on: Realtime private-channel auth, reducer replay guards (delta doubling, cascade survival, source retention), theme-aware synthesis shadow.
