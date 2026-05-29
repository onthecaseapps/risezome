---
date: 2026-05-28
topic: meeting-context-copilot
---

# Meeting Context Copilot

## Problem Frame

Knowledge workers lose meeting time looking up status, decisions, code, tickets, and metrics scattered across Confluence, GitHub, Jira, Trello, Snowflake, MySQL, and similar systems. When the answer doesn't exist anywhere, the question gets forgotten — and the same gap surfaces again in next week's meeting. The doc base never improves because nobody captures *what wasn't there*.

Existing AI meeting tools are split into camps that each address only part of this:

- **Transcribe + summarize** (Granola, Otter, Fireflies, Notion AI, tl;dv): post-meeting only. Granola explicitly chooses not to surface live.
- **Behavioral / sales-playbook live cues** (Gong, Chorus, Avoma, Read AI, Nomi): surface live, but only against CRM data or behavioral signals, and only for sales.
- **Enterprise RAG with meeting integration** (Glean + Zoom AI Companion, Microsoft 365 Copilot in Teams): multi-source enterprise grounding, but query-on-demand inside the meeting — the user has to ask.
- **Knowledge-gap detection** (Atlassian Rovo, Question Base): real, but driven from tickets or Slack, not from meetings.

As of mid-2026 no product ships the full combination: **ambient transcript monitoring + multi-source enterprise grounding + proactive surfacing (no query required) + documentation-gap feedback loop**, particularly for engineering/product/ops workflows. That combination is the wedge.

The initial user is an internal engineering team running planning and standup meetings. The architecture and integration surface generalize to sales, customer success, and customer-facing modes later, but those are deferred.

---

## System Shape (visual aid)

```
                +---------------------------------------------------+
                | Local desktop host (macOS / Linux / Windows)      |
                |                                                   |
   System +-----+--> Audio capture --> Transcription (streaming)    |
   audio        |        |                     |                    |
   + mic        |        |                     v                    |
                |        |          Rolling-window relevance ----+  |
                |        |          + question-pattern detect    |  |
                |        |                     |                 |  |
                |        |                     v                 |  |
                |        |          Source query (GitHub, Jira)  |  |
                |        |                     |                 |  |
                |        |        +------------+------------+    |  |
                |        |        |                         |    |  |
                |        |        v                         v    |  |
                |        |   Confidence high            Confidence|  |
                |        |   -> Card                    low + Q?  |  |
                |        |        |                     -> Gap    |  |
                |        |        v                         |    |  |
                |        |   Local HTTP/WS server  <--------+    |  |
                |        v        |                              |  |
                |   Transcript    v                              |  |
                |        +---> HUD (browser tab on localhost)    |  |
                |              [sidebar of cards + gap log]      |  |
                +-------------------------------------------------+
                                       |
                                       v
                                 Post-meeting view:
                                 pinned cards + gap list
                                 -> Confluence / Jira drafts
```

---

## Actors

- A1. **Engineer in meeting (live mode):** glances at the HUD during planning/standup. Pins cards that mattered. Optionally taps `Log gap` on detected unanswered questions.
- A2. **Engineer post-meeting (review mode):** same person, different mode. Reviews the per-meeting gap log and decides which gaps become Confluence drafts, Jira tickets, or get dismissed.

---

## Key Flows

- F1. **Live in-meeting surfacing**
  - **Trigger:** A1 starts the copilot before joining a meeting.
  - **Actors:** A1
  - **Steps:**
    1. Copilot begins capturing system + mic audio locally; no bot joins the call.
    2. Transcript streams to the local server; the HUD opens in a browser tab on localhost.
    3. As speech is recognized, the copilot evaluates rolling windows of transcript against the indexed GitHub + Jira corpus.
    4. Matching items surface as cards in the sidebar in chronological order with relevance score, source type, snippet, and source metadata (PR status, ticket state, author).
    5. A1 glances at the sidebar as needed; pinned cards persist at the top.
  - **Outcome:** A1 has live grounding context throughout the meeting without leaving the call.
  - **Covered by:** R1, R2, R3, R4, R5, R9, R10, R11

- F2. **Question-pattern detection + gap logging**
  - **Trigger:** A question pattern is detected in the live transcript ("what's the status of X", "do we have docs on Y", "remind me how Z works", "who owns W").
  - **Actors:** A1
  - **Steps:**
    1. Question detector flags the question span.
    2. Copilot queries indexed sources for the span; computes a confidence score.
    3. If confidence ≥ threshold → normal cards surface (F1).
    4. If confidence < threshold → a gap card appears with the verbatim question, the surrounding ~30s context, and a `Log gap` affordance.
    5. A1 either taps `Log gap` to persist the gap, or ignores it (auto-persist policy is a planning question).
  - **Outcome:** Questions that the knowledge base can't answer are captured instead of evaporating.
  - **Covered by:** R12, R13, R14

- F3. **Post-meeting gap review**
  - **Trigger:** A2 ends the meeting (capture stops or user clicks end).
  - **Actors:** A2
  - **Steps:**
    1. Copilot finalizes a meeting summary view: pinned cards, gap list, transcript link.
    2. A2 reviews each gap and chooses: draft a Confluence page, file a Jira ticket, mark as answered manually, or dismiss.
    3. The selected action executes against the connected source.
  - **Outcome:** Knowledge gaps funnel into documentation or backlog rather than getting lost.
  - **Covered by:** R15, R16

---

## Requirements

**Capture & transcription**
- R1. Capture local system audio + microphone on macOS, Linux, and Windows without joining the meeting as a bot.
- R2. Produce a near-real-time transcript visible to the user, with best-effort speaker diarization.
- R3. Audio capture works uniformly across Zoom, Google Meet, Microsoft Teams, and Slack huddles — no per-meeting-platform integration in the capture layer.

**Local-first delivery shape**
- R4. Ship as a desktop background process that exposes a local HTTP + WebSocket server.
- R5. The user-facing HUD is a web page served from the local server, viewable in any browser on the same machine.

**Source integration (v1)**
- R6. Integrate with GitHub (issues, pull requests, repo README content, code search) using user-supplied tokens stored locally.
- R7. Integrate with Jira (issues, statuses, comments) using user-supplied tokens stored locally.
- R8. The source integration architecture is extensible — adding Confluence, Trello, Snowflake, MySQL, Notion, etc. must not require core refactoring.

**Relevance & live surfacing**
- R9. As the transcript progresses, the copilot continuously evaluates rolling windows against the indexed source corpus and surfaces matching items as cards in the HUD sidebar.
- R10. Each card shows source type, title, snippet, relevance score, and source-level metadata (e.g., PR status, ticket state, author, last update).
- R11. Cards stream chronologically and persist for the meeting duration. The user can pin a card; pinned cards remain at the top of the sidebar.

**Question detection & gap logging**
- R12. The copilot detects question patterns in the transcript and flags them as candidate gap-events.
- R13. When a flagged question yields no source result above the configured confidence threshold, a gap card appears in the HUD with a `Log gap` affordance.
- R14. Each logged gap captures the verbatim question, transcript timestamp, ~30s of surrounding context, and the list of sources searched.

**Post-meeting outputs**
- R15. After the meeting ends, the copilot produces a summary view containing the pinned cards, the gap list, and a link to the full transcript.
- R16. The user can convert any logged gap into a draft Confluence page or a Jira ticket from the post-meeting view.

---

## Acceptance Examples

- AE1. **Covers R9, R10.** Given a sprint planning meeting where the transcript contains "what's the deal with the auth refactor", and the copilot has indexed a GitHub PR titled "Replace JWT middleware" (status: open) and a Jira ticket SEC-204 ("Auth middleware migration", status: in review), when the question is spoken, then within a small number of seconds two cards appear in the sidebar showing those items with relevance ≥ 80% and their current statuses.
- AE2. **Covers R12, R13, R14.** Given the transcript contains "what's the rollout plan for the auth refactor?", when no indexed source returns a result above the confidence threshold, then a gap card appears showing the verbatim question, the surrounding ~30s of transcript, and a `Log gap` button. When the user clicks `Log gap`, the gap is persisted with timestamp, surrounding context, and the list of sources searched.
- AE3. **Covers R11.** Given multiple cards have surfaced during a meeting, when the user clicks the pin icon on a card, then that card moves to a pinned section at the top of the sidebar and stays visible for the rest of the meeting.
- AE4. **Covers R15, R16.** Given a meeting ended with two pinned cards and three logged gaps, when the user opens the post-meeting view, then both pinned cards and all three gaps are visible. When the user clicks "Draft Confluence page" on a gap, a Confluence draft is created in the configured space containing the question and the surrounding context.

---

## Success Criteria

- **Sustained voluntary use** is the primary product signal. Target: in a pilot of ≥ 10 engineers across ≥ 3 teams, ≥ 50% leave the copilot running for the majority of their planning and standup meetings for at least two consecutive weeks without prompting. Sustained use is the harshest test of the ambient promise — a noisy or wrong HUD gets turned off quickly.
- **Handoff quality:** the downstream planning agent (`/ce-plan`) can choose an architecture and begin implementation without needing to invent product behavior, UX shape, or success criteria. The only unknowns remaining at planning time are technical.

---

## Scope Boundaries

### Deferred for later

- Source integrations beyond GitHub + Jira (Confluence, Trello, Notion, Snowflake, MySQL, etc.). The integration architecture (R8) supports them; v1 ships two.
- Sales / CS / customer-facing modes, including CRM grounding and customer-account data.
- Modes where the *customer's own data* is the source of truth.
- Auto-generated Confluence pages or Jira tickets from gaps — v1 only logs gaps and offers manual conversion (R16).
- Mobile capture and phone-only meetings.
- Multi-user shared sessions, team-shared knowledge graphs, per-meeting access control — v1 is single-user.
- A bot-joins-the-call capture mode.
- Threshold-triggered alert UX, on-demand-only UX, and hybrid alert+sidebar UX — v1 is always-on rolling sidebar.
- Wake words and voice interface.
- Integrations with Microsoft Teams Copilot, Zoom AI Companion, or Google Meet Gemini — local capture replaces these for v1.

### Outside this product's identity

- Sales coaching, talk-ratio metrics, sentiment scoring, deal intelligence. That is Gong / Chorus / Nomi / Read AI territory; we are not competing there.
- Post-meeting summary as the headline value. We ship a summary, but the live surfacing + gap loop is the pitch — not "the best transcript archive."
- General-purpose enterprise search / chat UI. That is Glean / Dust territory; we are meeting-bound.
- Meeting recording / archival as a primary purpose. We may store transcripts; we are not selling "your recorded meetings library."
- Calendar, scheduling, or agenda-building tools.

---

## Key Decisions

- **Live surfacing is primary; the doc-gap loop is secondary but shipped in v1.** Rationale: surfacing is the user-pull demand; the gap loop is the defensible moat and the compounding-value half. Both must ship for the wedge to be honest.
- **Local audio capture, no bot, local webserver + browser HUD.** Rationale: trivial cross-platform UI via the browser, zero bot friction with IT, strong privacy default, no per-meeting-platform integration to maintain.
- **Engineering planning + standup meetings, GitHub + Jira sources, v1.** Rationale: smallest scope that exercises every architectural piece (multi-source RAG, ambient surfacing, gap loop). Horizontal expansion follows demand.
- **Always-on rolling sidebar UX.** Rationale: lowest cognitive load that preserves the ambient promise. Alternative modes (threshold alerts, on-demand) are explicitly deferred.
- **Sustained voluntary use as the primary success metric.** Rationale: the harshest, hardest-to-game test of the ambient promise.
- **The integration layer must be plugin-shaped from day one.** Rationale: v1 ships only GitHub + Jira, but the explicit "what's left out" list contains many sources we plan to add. Building a non-extensible integration layer twice is more expensive than building it once.

---

## Dependencies / Assumptions

- Cross-platform local system-audio capture (macOS, Windows, Linux) is implementable with reasonable engineering effort. Each OS has a known loopback API (CoreAudio + ScreenCaptureKit, WASAPI loopback, PulseAudio / PipeWire). *Unverified at brainstorm time — needs platform research at planning.*
- A near-real-time transcription engine of acceptable accuracy and cost exists. Candidates include local Whisper variants (whisper.cpp, Faster-Whisper) and hosted streaming APIs (Deepgram, AssemblyAI). *Unverified — benchmarked at planning.*
- GitHub and Jira REST/GraphQL APIs provide sufficient read access (issues, PRs, code, ticket metadata) with personal access tokens for v1. *Believed true; verify against current API surfaces at planning.*
- Pilot users are willing to install a desktop background process and use a localhost browser tab as the HUD. Validated with the first 3 pilots.
- The working repository for this product does not yet exist. The `/home/nathan/dev/upwell` directory is empty at brainstorm time — no prior code, no conventions, no constraints to inherit.

---

## Outstanding Questions

### Resolve Before Planning

_(none — every remaining question is a technical or research question best answered during planning.)_

### Deferred to Planning

- [Affects R1, R2, R3][Technical] Cross-platform system-audio capture strategy — native helpers per OS vs. a cross-platform library (libsoundio, miniaudio).
- [Affects R2][Needs research] Transcription engine choice — local Whisper variants vs. Deepgram vs. AssemblyAI. Latency, accuracy, cost benchmarks.
- [Affects R9, R12][Needs research] Embedding model + vector store choice — local (BGE / MiniLM + Chroma / Qdrant local) vs. hosted (OpenAI embeddings + Pinecone / Qdrant Cloud).
- [Affects R8][Technical] Source-integration plugin contract — indexing strategy, refresh cadence, query interface.
- [Affects R12][Needs research] Question-detection approach — pattern + classifier vs. LLM extraction. Latency budget per detection.
- [Affects R9, R13][Needs research] Confidence threshold default and per-source calibration; how pilots tune it.
- [Affects R1–R7][Privacy positioning] Whether to position as local-first-by-default with cloud opt-in, cloud-allowed-by-default with local-only mode, or hybrid (audio local, derived data cloud). Marketing/positioning consequence; deferred per user direction.
- [Affects R13] Auto-persist policy for gaps — does a flagged-and-uncovered question always get logged, or only on explicit `Log gap` click?
- [Affects R15, R16] Where the post-meeting summary and gap log are stored — local only, optionally synced to user's cloud, or both.
- [Affects success criteria] Pilot recruitment — which 3+ engineering teams, and how "sustained voluntary use" is instrumented.

---

## Next Steps

-> `/ce-plan` for structured implementation planning
