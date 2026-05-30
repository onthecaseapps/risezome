---
date: 2026-05-30
topic: upwell-portal-and-cloud-shape
---

# Upwell Portal & Cloud-First Product Shape

This brainstorm reshapes Upwell from a desktop-installed copilot into a hosted SaaS product. The desktop daemon stops being the end-user surface; its engine code (transcription consumer, retrieval, synthesis) moves into a backend worker. The user experience becomes: sign in with Google, install an Upwell GitHub App on the org's repos, opt in per-meeting from the portal, glance at a second-monitor portal tab during the call.

## Problem Frame

Today Upwell ships as a local daemon a developer installs, configures via `.env`, and runs alongside their browser. That model has friction at every step: install a daemon binary, get sidecar entitlements right per OS, manage half a dozen API keys, manually start audio capture before each meeting. Most candidate users won't get past the first step. We've validated the live in-meeting card experience itself with the HUD work in `apps/hud-next/` — the engine works. The block is the surface.

Bot-based meeting recorders (Recall.ai, Read.ai, Granola, Fireflies, tl;dv) have solved the install-friction problem: they sign up, connect calendar, the bot joins on their behalf. Upwell's differentiator — proactive multi-source RAG grounding during the meeting, not post-meeting summary — is independent of how audio gets captured. Today the audio comes from a local sidecar; nothing about the retrieval/synthesis pipeline cares that.

Reshape: move audio capture to a Recall.ai bot, run the existing daemon's engine code as a backend worker, surface everything through a hosted portal at upwell.com. Keep the product's actual point (live grounding cards) intact; remove every friction point that isn't the actual product.

This brainstorm establishes product shape — primary actors, core surfaces, tenancy model, retention posture, consent model. It does not specify implementation; that's planning's job.

---

## System Shape (visual aid)

```
                              upwell.com
   Google Calendar              (Vercel: portal +
   (per-user OAuth)             marketing site)
        |                            |
        |                            |
        v                            v
   Calendar poller -->  Supabase Postgres + pgvector
                        - users, orgs, org_members
                        - sources (GitHub App installs)
                        - meetings (metadata + transcripts
                          + cards + syntheses + gaps)
                        - corpus chunks + embeddings
                        - RLS: scope to org membership
                            |
                            |  enqueue
                            v
                        Job queue (indexing, bot-launch)
                            |
              +-------------+--------------+
              |                            |
              v                            v
   Indexer worker                   Bot worker
   (GitHub App auth,                (one process per active meeting,
    pulls repo content,              receives Recall.ai transcript
    embeds, writes chunks)           stream + emits cards through
                                     Supabase Realtime to portal)
                                            |
                                            v
                                     Recall.ai bot
                                     (joins meeting URL,
                                      announces itself, streams
                                      audio out via webhook/WS)


   User in meeting (Zoom/Meet)                          Portal tab on
        |                                               other monitor:
        +--- bot joins, announces ---> [in meeting] --> live cards arrive
                                                        via WS subscription
```

Two things are deliberately out of this diagram for MVP: per-user local capture (the daemon as end-user component) and any client other than a browser tab.

---

## Actors

- **A1. Beta tester (org member, signed in).** Signs in with Google. Toggles per-meeting opt-in for their upcoming calls in the portal. Glances at the portal tab during meetings. Reviews pinned cards and gap log after.
- **A2. Org admin (also an org member, with elevated role).** Installs the Upwell GitHub App on their org's repos. Manages org-level settings: members, sources, retention. Has the same in-meeting experience as A1 — being an admin doesn't change the live UX.
- **A3. Solo user.** A1 without a team. Their org is themselves; they install the GitHub App on their own repos. The shape is the same; the data is single-tenant from their perspective.

The original local-daemon developer audience is **explicitly deferred** to a later wave; their needs (privacy via local audio, custom corpus sources, offline-capable) are real but cost the product the lowest-friction path we're committing to here.

---

## Key Flows

### F1. First-time onboarding

1. New user lands on `upwell.com`, clicks "Sign in with Google."
2. Google OAuth grants identity + read-only calendar scope.
3. Portal prompts: "What's the name of your team?" → creates an org, makes the user the first admin member.
4. Portal prompts: "Install the Upwell GitHub App on your org's repos." User clicks → goes to GitHub → picks repos → returns to portal with installation confirmed.
5. Indexer begins indexing those repos in the background. Portal shows per-source progress.
6. Portal lands on the "Upcoming meetings" view, empty-state explaining: "Toggle the bot on any meeting below to have Upwell join."

### F2. Opt-in per meeting

1. A1 opens the portal. The home view shows their next 7 days of calendar events.
2. For each event, a clear toggle: "Send Upwell bot." Off by default.
3. A1 flips the toggle on for a meeting later today. Portal records the opt-in against the calendar event ID + meeting URL.
4. (Implicit) When the meeting is rescheduled, the opt-in carries forward with the event ID.

### F3. Live in-meeting experience

1. The meeting starts. A1 is in Zoom; Upwell's bot joins, announces itself ("Upwell is taking notes for [user]"), and begins streaming audio out.
2. The bot worker spins up, ingests audio → transcription (Deepgram) → retrieval pipeline → synthesis card stream.
3. A1 opens (or already had open) the portal tab for this meeting on a second monitor. The view shows the live HUD (the U1-U5 work from `apps/hud-next/`) inside the portal layout.
4. Cards stream in as topics come up; A1 glances at them.
5. (Optional) A1 pins cards mid-meeting; pin state persists for post-meeting review.

### F4. Post-meeting review

1. Meeting ends; bot leaves. The portal's meeting page transitions to a "completed" state.
2. The page shows: pinned cards (top), full card stream (chronological), synthesis text, gap log (unanswered questions), transcript link.
3. A1 can convert gaps into actions (e.g., "draft a Jira ticket"); deferred surface — out of MVP, but the gap data must be captured to enable this later.

### F5. Source management & reindex

1. A2 (admin) opens "Sources" in the portal.
2. Sees the list of repos covered by the GitHub App installation, last-index timestamp, indexed chunk count per repo.
3. Can click "Reindex" on any source. Job enqueued; progress visible.
4. Can add/remove repos from the installation (link out to GitHub).

### F6. Retention & data delete

1. A1 opens any past meeting; "Delete this meeting" is available. Removes transcript, cards, synthesis, gaps, all derivatives.
2. Raw audio was never persisted past the live transcription stream; nothing to delete there.

---

## Requirements

### Auth & tenancy

- **R1.** Sign-in is Google SSO only for MVP. Identity is the user's verified Google email.
- **R2.** Every user belongs to exactly one org for MVP. (Multi-org membership is a deferred enhancement.) An org has at least one admin.
- **R3.** Tenancy is enforced at the data layer (row-level security against org membership) — no app-layer-only filtering.
- **R4.** Provider API keys (Anthropic, Voyage, Deepgram, Recall.ai) are platform-owned and never exposed to users. Cost is borne by the platform during beta.

### Calendar

- **R5.** The user connects exactly their Google Calendar (the calendar tied to their Google SSO account). Multi-calendar and Outlook support are deferred.
- **R6.** The portal shows upcoming calendar events for the next 7 days, refreshed on portal load and via push (Google Calendar push notifications) when available.
- **R7.** The portal extracts the conference link (Zoom / Google Meet / Webex / Teams join URL) from each event. Events without a conference link cannot be opted in.

### Bot opt-in & consent

- **R8.** Default policy: bots **do not** auto-join any meeting. Joining is per-event opt-in by a member of the org.
- **R9.** Each calendar event has a "Send Upwell bot" toggle in the portal. The toggle persists per event; if the event is rescheduled, the opt-in carries forward.
- **R10.** When the bot joins, it announces itself in-meeting via both an in-meeting chat message and an audio announcement ("Upwell is taking notes for [user]"). Consent is recorded inside the meeting itself.
- **R11.** The bot is sent to the conference URL from R7 via Recall.ai. If the URL is missing or invalid at start time, the opt-in is failed loudly in the portal (banner / email).
- **R11a.** MVP conference platform support: **Zoom and Google Meet only**. Both fully support chat + audio bot announce per R10 and have the most stable bot-join behavior per Recall.ai's platform reports. Microsoft Teams, Webex, and GoTo Meeting are explicitly deferred — see Scope Boundaries for rationale.
- **R11b.** Bot configuration on every Create Bot call **must explicitly set `retention=null`** (ephemeral / Zero Data Retention mode) and use `prioritize_low_latency` transcription mode. Defaults persist recordings indefinitely; the platform-side default changed in June 2025 from "7-day expiry" to "retain forever." Enforce in code, not in dashboard config. Logged at WARN if a bot is created without `retention=null` set.

### Sources & indexing

- **R12.** Source connection at MVP is a GitHub App installed at the org level on a set of repos selected by an admin. (Per-user OAuth tokens are not the primary path.)
- **R13.** Indexing runs on platform infrastructure, not on the user's machine. Each source has visible status: idle / indexing / last-indexed-at / errored.
- **R14.** Reindex is available per source from the portal, on demand. (Periodic reindex cadence is deferred to planning.)
- **R15.** Indexed corpus is org-scoped. All members of an org see the same retrieval results.

### Live in-meeting surface

- **R16.** During an opted-in meeting, the portal's meeting page renders the live HUD (cards, synthesis, gaps) sourced from a server-side bot worker. Functional parity with `apps/hud-next/` is the baseline.
- **R17.** The user is expected to open the meeting's portal page on a second monitor; the product does not require any non-browser client.
- **R18.** Live data flows from bot worker → Supabase Realtime channel → portal page. No portal-to-localhost connection.

### Retention & deletion

- **R19.** Raw audio is consumed by transcription and discarded; nothing is persisted past the live stream. Implemented via Recall.ai's Zero Data Retention mode (`retention=null` on every Create Bot call). This forces `prioritize_low_latency` ASR mode — `prioritize_accuracy` is incompatible with ZDR. The latency-mode tradeoff is acceptable for the live-stream use case.
- **R20.** Transcripts, cards, syntheses, gaps, and pin state are persisted indefinitely (no time-based purge for MVP) and scoped to the meeting + org.
- **R21.** A user can delete any past meeting they had access to; deletion removes all derived artifacts.

### Storage & infrastructure

- **R22.** All persistent data lives in the platform-controlled cloud database (Postgres + pgvector for embeddings). User machines hold nothing persistent.
- **R23.** Backend jobs (indexing, bot-launch, transcript processing) run on platform compute, on a queue or workflow runner — not synchronously in HTTP request handlers.
- **R23a.** Live in-meeting card/synthesis events are delivered to the portal via Supabase Realtime Broadcast. Because Broadcast is fire-and-forget, every event also writes to Postgres as the source of truth; the portal page recovers state via DB fetch on reconnect, then resumes the live channel. No event is "in Realtime only."

### Surface scope

- **R24.** Portal MVP surface (no more, no less): Sign in, org/admin setup, GitHub App install, Sources view with reindex, Upcoming meetings view with per-meeting toggle, Live meeting view (the HUD), Past meeting view with pinned cards + gaps + transcript, Settings (org name, members, GitHub install management).
- **R25.** No API key vault in the portal UI. No "enter your Anthropic key" — those keys are platform-internal.
- **R26.** When a bot fails to join (invalid URL, platform-side error, network failure), the portal surfaces a clear diagnostic on the affected meeting: the Recall.ai error code, a human-readable explanation, and the next action ("retry," "edit URL," or for Teams in scope later: "ask IT admin to whitelist our bot domain"). Silent failures are not acceptable — R11 already commits to this, but R26 specifies the portal-side surfacing.

### Engine integration

- **R27.** The retrieval+synthesis pipeline (today's `apps/daemon/src/retrieve/` + `apps/daemon/src/synthesize/`) must consume Recall.ai's wrapped transcript format, not Deepgram's native format. An adapter layer translates `{ speaker_name, words: [{ text, start, end }] }` into the existing utterance shape. The retrieval/synthesis code itself stays unchanged.

---

## Acceptance Examples

- **AE1. Covers R1-R3, R12.** Nathan opens upwell.com, signs in with Google (`nathan@example.com`). Portal creates an org named "Example Inc.", makes Nathan the admin. He clicks "Install GitHub App," selects 3 repos from his GitHub org, returns to the portal. The Sources view shows those 3 repos with "indexing" status. Another member of the same org (added via invite) signs in and sees the same 3 sources without any setup.

- **AE2. Covers R7-R11, R11a, R11b, R19.** Nathan has a Google Meet in his calendar for 2pm: "Sprint Planning, meet.google.com/abc-defg-hij". In the portal at 1:30pm he sees the event and flips "Send Upwell bot" on. At 2:00pm Recall.ai joins the Meet (Create Bot called with `retention=null` and `prioritize_low_latency`), posts a chat message ("Upwell is taking notes for Nathan") and speaks the same announcement. At 2:05pm Nathan opens the meeting's portal page; cards relevant to the conversation are streaming in. The meeting at 3pm ("Personal", no Meet link) shows a disabled toggle with hint "no conference link." The 4pm meeting is in Microsoft Teams; its toggle is also disabled with hint "Teams support coming soon" (R11a).

- **AE3. Covers R16-R18, R20.** During Nathan's 2pm meeting, his portal tab on the second monitor shows cards arriving within ~3 seconds of relevant utterances. He pins one. At 2:55pm the meeting ends; the portal page transitions to "Completed" and shows the pinned card at top, the full stream below, and a 1-paragraph synthesis. Two days later he reopens the meeting and the same content is intact.

- **AE4. Covers R12, R15.** Alice (different org member, same Upwell org as Nathan) has her own 2pm meeting on a different topic. Her bot's retrieval pulls from the same indexed repos as Nathan's. Her meeting data (transcript, cards) is scoped to her meeting; Nathan cannot see it.

- **AE5. Covers R19, R21.** Nathan opens an old meeting, clicks "Delete." Transcript, cards, gap log are removed from the database. The raw audio of that meeting was never persisted; there is nothing to also delete server-side.

---

## Scope Boundaries

### In scope for the first hosted release

- The 25 requirements above.
- Engineering the existing daemon code into a server-side worker that consumes Recall.ai transcript output and runs the retrieval+synthesis pipeline.
- A portal Next.js app sharing infrastructure with the existing landing page (`apps/upwell-landing-page` route extension is the natural home), or a new app inside the same repo.
- Supabase or equivalent for auth + Postgres + pgvector + Realtime. (Concrete stack choice deferred to planning.)
- Indexing worker that uses the GitHub App's installation token to pull and embed repo content.

### Deferred for later

- Local audio capture as a tier or option for privacy-sensitive users. The daemon code is preserved in the repo for this future; it just isn't a user-facing component in the first release.
- **Microsoft Teams platform support.** Recall.ai's Teams bot is built on DOM scraping of the Teams web client; Microsoft makes undocumented changes and intermittent failures are routine. Enterprise tenants additionally require IT-admin domain whitelisting (a customer-success problem, not just engineering). Worth waiting until we have a customer who needs it and is willing to do the whitelist.
- **Webex and GoTo Meeting platform support.** Both lack chat-from-bot in Recall.ai, so the R10 announce model degrades to audio-only on those platforms. Not a blocker, but a weaker consent surface; defer until we have demand.
- Outlook / Microsoft 365 Calendar integration.
- Slack and Jira corpus sources (the existing code can index them; only GitHub is wired through the portal at MVP).
- Multi-org membership per user.
- Heuristic/automatic auto-join (e.g., "auto-join if 2+ external attendees"). The opt-in policy is intentionally manual at MVP.
- Browser extension / overlay on top of Zoom/Meet. Native desktop companion. Mobile second-screen.
- Pricing & billing UI. Beta is free; usage costs are borne by the platform until we know what to charge.
- Gap-to-Jira / Gap-to-Confluence drafting (R24 leaves this off MVP but the gap data must be captured for it).
- User-configurable retention windows. Retention is "kept indefinitely or deleted explicitly" at MVP.
- Recording storage. Audio is discarded after transcription with no option to retain at MVP.
- **Self-hosted / open-source bot transport** (Attendee.dev or similar). At Upwell's scale today, Recall.ai's ~$0.65/hr PAYG with no minimum is the path of least resistance. If usage growth makes Recall.ai costs a real budget item, Attendee.dev becomes interesting — it covers Zoom/Meet/Teams via Zoom RTMS (more stable than DOM scraping), delivers raw audio (no Recall transcript wrapper), and has no per-minute fee. The price is real DevOps burden. Worth keeping on the radar as a 12-month-out cost lever, not an MVP path.

### Outside this product's identity

- Becoming a generic transcription/recording service (Otter, tl;dv). Upwell's point is proactive multi-source grounding during the meeting; the transcript is means, not product.
- Post-meeting AI summary as the primary value. Other tools already do this well; we'd be undifferentiated.
- Sales-only or CRM-tied positioning (Gong, Chorus). Upwell's wedge is engineering/product/ops meetings whose grounding lives in repos and tickets, not CRMs.
- A meeting scheduling tool. We consume calendars; we don't write to them.

---

## Dependencies / Assumptions

- **Recall.ai is the bot transport.** *Verified at brainstorm time:* PAYG at $0.50/hr bot + $0.15/hr transcription = $0.65/hr all-in, no minimum or sales gate; first 5 hours free. For 50 beta users × 5 meetings/wk × 30 min each ≈ 540 hrs/month ≈ **$350/month platform cost** — manageable for beta. Verdict: appropriate MVP choice.
- **Recall.ai Zero Data Retention mode satisfies R19.** *Verified:* setting `retention=null` on Create Bot prevents Recall from persisting audio/video at any point; live-stream-only access. Incompatible with `prioritize_accuracy` ASR mode — must use `prioritize_low_latency`. Acceptable tradeoff. Critical: default behavior changed in June 2025 to retain indefinitely; ephemeral mode must be set explicitly on every bot creation. R11b enforces this.
- **Recall.ai's Deepgram integration preserves our existing pipeline shape with an adapter layer.** *Verified:* Recall offers `deepgram_streaming` as a transcription provider option (BYO Deepgram key), but the emitted transcript format is Recall-wrapped (`{ speaker_name, words: [...] }`), not Deepgram's native shape. R27 calls out the adapter; the retrieval/synthesis code does not change.
- **Google Calendar API push notifications** are reliable enough that the portal doesn't need aggressive polling. Polling is a fine fallback. *Standard assumption.*
- **The existing retrieval+synthesis pipeline runs as a worker** without depending on the local-daemon-specific bits (sidecar IPC, OS audio). Sidecar code stays in the repo but is unused in the cloud worker. *Likely true — needs a planning-time spike.*
- **Supabase RLS + pgvector + Realtime Broadcast** is the chosen stack — see OQ1 (resolved). RLS is performant at beta scale provided org_id columns are indexed and policies stay simple (unindexed RLS-policy columns have caused multi-minute query times in reported production cases). Realtime Broadcast has a fire-and-forget delivery model — card events must also be persisted to Postgres so the portal client can recover state via DB fetch on reconnect. Both are tractable.
- **The landing page Next.js app (`apps/upwell-landing-page`)** is the natural home for portal routes given the prior brainstorm explicitly built it for that purpose. *Verified — see `docs/brainstorms/2026-05-29-upwell-landing-page-requirements.md` "site shell must be built so a customer portal can hang off it later."*
- **The HUD work in `apps/hud-next/`** is reusable as the live in-meeting surface inside the portal. Its WebSocket-based event consumption maps onto Supabase Realtime subscriptions with modest plumbing changes. *Verified by the just-completed cutover; bootstrap config + WS URL become the portal-side config injection.*

---

## Outstanding Questions

### Resolve before planning

- **OQ1. Stack: RESOLVED — Supabase full stack.** Spike completed at brainstorm time. Supabase Auth (Google OAuth) + Supabase Postgres + pgvector + Supabase Realtime Broadcast + RLS for tenancy. One platform, one schema, no glue between auth/data/realtime. Cost at beta scale is $0 (free tier) → $25/mo (Pro) once we cross the free-tier inactivity-pause boundary. Realtime Broadcast is fire-and-forget — the portal client must be designed to recover via DB-state fetch on reconnect; not a problem given the events are also written to Postgres as a side effect of being processed. **Better Auth + Neon + Ably is the documented fallback** if Supabase reliability fails us in production or if we hit the ~1000 MAU point where Clerk's free 50K MAU becomes meaningfully cheaper (we'd switch auth to either Clerk or Better Auth and keep Supabase as just-the-DB at that point). **Auth.js v5 is off the table** — it entered maintenance mode September 2025; Better Auth is its successor for projects considering that family. Decision logged at planning kickoff, but no further research needed.
- **OQ2. Bot worker shape: one process per meeting, or a worker pool sharing meetings?** Recall.ai emits a stream per bot; the engine can be horizontally scaled either way. The shape affects cost (process overhead vs. context-switch overhead) and the failure model (a crash kills one meeting vs. many). Planning-time decision driven by Recall.ai's webhook/WS contract and the engine's per-meeting memory footprint.
- **OQ3. What does the Live Meeting view actually look like during opt-in but before the meeting starts?** Pre-meeting context-prep (background fetch of likely-relevant context based on meeting title/attendees/description) is a strong differentiator and adjacent to the core. Decide: is pre-meeting prep in MVP (R24 is silent on this), or post-MVP polish?
- **OQ4. How does the user pre-configure their Recall.ai account on Upwell's side?** A platform-level Recall.ai account has its own dashboard (BYO Deepgram key configured there). For MVP this is a one-time platform setup, not user-facing. Confirm at planning kickoff that no per-user Recall.ai keying is required (it shouldn't be, but worth verifying so we don't accidentally surface that complexity to users).

### Deferred to implementation

- **DQ1. Concrete pgvector partitioning** (one table per org? one global table with org_id?) — performance + RLS tradeoff worth a planning-time micro-spike.
- **DQ2. Exact Realtime channel topology** (one channel per meeting? per user? per org?) — Supabase Realtime auth model decides this.
- **DQ3. Where the meeting-event ↔ bot launch trigger lives** (cron polling Google Calendar API? webhook from Calendar's push notifications? cron-scanning the local DB of opt-ins?). Planning will pick.

---

## Out-of-band note: relationship to existing artifacts

This brainstorm explicitly redefines the product shape that `docs/brainstorms/meeting-context-copilot-requirements.md` originally framed. It does not contradict the core thesis ("ambient transcript monitoring + multi-source RAG + proactive surfacing + gap loop") — every load-bearing decision from that brainstorm survives. It re-platforms the *delivery*: cloud-first SaaS instead of local daemon. The local-daemon path becomes a deferred secondary tier.

The HUD conversion plan (`docs/plans/2026-05-30-001-feat-hud-nextjs-conversion-plan.md`, just shipped) becomes the foundation of the live in-meeting view: the React+Next.js HUD app is the same surface, now embedded in the authenticated portal instead of served by a local daemon.
