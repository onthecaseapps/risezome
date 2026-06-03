---
date: 2026-06-02
topic: knowledge-gaps
---

# Knowledge Gaps — Requirements

## Summary

A **Knowledge Gaps** library that turns questions the copilot couldn't answer in meetings into a managed backlog of things the team's knowledge base doesn't yet cover. Misses are captured automatically, recurring questions merge into a single demand-ranked gap with a frequency count, gaps auto-cluster into editable sections, and each gap can be assigned to a teammate and marked done.

## Problem Frame

Every meeting produces questions the copilot can't answer — the corpus doesn't cover them yet. Today those questions evaporate the moment the meeting ends. Nobody writes them down, so the same question gets asked again next week by a different person, and again next month by a new hire, each time costing an interruption and an answer that never gets captured. The signal that would tell a team *exactly what to document next* — which questions keep coming up and can't be answered — is generated continuously and thrown away continuously.

The copilot is already in the perfect position to catch this: it sees every question, tries to answer each, and knows precisely which ones it couldn't ground. The cost of the gap is invisible because it's diffuse — a few minutes here, a re-asked question there — so no one owns fixing it. Making the gaps visible, deduplicated, and ranked by how often they recur turns that diffuse cost into a concrete, prioritized backlog someone can act on.

## Key Decisions

- **Auto-capture, no confirmation gate.** Every miss becomes a gap automatically. Cleanliness comes from dedup, clustering, and a dismiss action — not a triage queue a human has to clear. Chosen for coverage over a curated inbox.
- **Semantic merge with frequency.** Recurring questions collapse into one gap that tracks how often it's been asked, so the library is demand-ranked — a map of what the team repeatedly can't answer, not a raw log.
- **Auto-cluster, human-curate.** Sections are generated automatically by subject and are fully editable; human curation (renames, merges, moves) survives re-clustering when new gaps arrive.
- **Resolution is "mark done."** A gap closes when a person says so. v1 captures no canonical answer and performs no automatic verification that the gap is actually fixed.
- **Internal assignment only.** A gap is assigned to a workspace member with in-app notification. No pushing gaps to external trackers in v1.
- **Post-meeting batch assembly.** Gaps are computed when a meeting ends (alongside the existing recap), because dedup and clustering are inherently cross-meeting and can't happen live.
- **Org-wide library, manager-curated.** Every member can view the library and their assigned gaps; managers curate sections, assignment, and dismissal.

## Actors

- A1. **Copilot (system)** — detects misses during a meeting and runs the post-meeting assembly: capture, merge, cluster.
- A2. **Meeting participants** — ask the questions that become gaps; their names attach to occurrences as "asked by."
- A3. **Manager / curator** — organizes sections, assigns gaps, dismisses noise, resolves.
- A4. **Assignee (owner)** — the member responsible for closing a gap assigned to them.

## Key Flows

- F1. **Capture & assemble (post-meeting).** A meeting ends → the system collects that meeting's unanswered questions → merges each into a new or existing gap by semantic match → records the occurrence and increments frequency → re-clusters gaps into sections (preserving human curation) → the gaps appear in the library.
- F2. **Triage & organize.** A manager browses the demand-ranked library, renames / merges / splits sections, moves gaps, and dismisses noise.
- F3. **Assign & notify.** A manager assigns a gap to a member → the member is notified in-app → the gap appears in that member's "assigned to me" view.
- F4. **Resolve.** The owner or a manager marks a gap done (or dismisses it) → it leaves the open view. If the same question recurs later, a new occurrence is recorded and the gap re-surfaces for attention.

## Requirements

**Capture**

- R1. The system records a knowledge gap whenever the copilot attempts to answer a substantive question in a meeting but cannot produce a grounded, cited answer (no relevant context found, nothing retrieved, or the answer suppressed for lack of grounding). Capture is automatic, with no human step.
- R2. A captured gap retains the verbatim question, the meeting and moment it was asked in, who asked it, and when.
- R3. Gaps are assembled and appear after the meeting ends, not live during it.

**Recurrence & ranking**

- R4. When the same or a semantically similar question is asked more than once — within or across meetings, by any participant — the occurrences merge into one gap rather than separate entries.
- R5. A gap tracks how many times it has been asked and the list of individual occurrences (meeting, asker, timestamp).
- R6. The library ranks gaps by recurrence by default — the most-asked surface first.

**Sections (grouping)**

- R7. Gaps are automatically grouped into sections of related questions (by subject / project / task).
- R8. A user can rename a section, merge two sections, split a section, and move a gap between sections.
- R9. A new gap is auto-placed into the best-matching existing section; when none fits, it lands in an uncategorized bucket.
- R10. Human curation of sections (names, membership, moves) persists across re-clustering — new gaps arriving must not overwrite manual organization.

**Assignment**

- R11. A gap can be assigned to one workspace member as its owner.
- R12. An assignee is notified in-app when a gap is assigned to them and can see all gaps assigned to them in one view.

**Resolution & lifecycle**

- R13. A gap has a status: open, resolved, or dismissed.
- R14. A user can mark a gap resolved ("done") or dismiss it; the action records who did it and when.
- R15. Resolved and dismissed gaps leave the default (open) view but remain retrievable via filter.
- R16. If a question matching a resolved or dismissed gap is asked again, the occurrence is recorded against that gap, its frequency increments, and the gap re-surfaces for attention (flagged as asked again after closing).

**Library & browse**

- R17. A user can search gaps by text and filter by section, assignee, and status.
- R18. A user can sort by most-asked, newest, and unassigned.
- R19. An "assigned to me" view shows the current user's owned gaps.
- R20. Each gap and each occurrence links back to the meeting and the moment in the transcript where the question was asked.

**Visibility & permissions**

- R21. The gap library is visible to all members of the workspace; a member can see every gap and the gaps assigned to them.
- R22. Curation actions (assign, dismiss, rename / merge / split / move sections) are available to managers; an assignee may resolve or dismiss a gap assigned to them.

## Acceptance Examples

- AE1. **Covers R4, R5.** A question semantically equivalent to an existing gap is asked in a later meeting → no new gap is created; the existing gap's frequency increments and the new occurrence is appended.
- AE2. **Covers R4.** A different question that merely shares keywords with an existing gap (different topic) → a separate gap is created, not merged.
- AE3. **Covers R8, R10.** A manager renamed a section and moved a gap into it; a later meeting adds gaps and triggers re-clustering → the renamed section and the moved gap stay as the manager left them.
- AE4. **Covers R16.** A gap was marked resolved last week; its question is asked again this week → a new occurrence is recorded, frequency increments, and the gap re-surfaces flagged "asked again after resolved."
- AE5. **Covers R14, R22.** A member assigned a gap marks it done → status becomes resolved and is recorded as closed by that member.
- AE6. **Covers R1.** Filler or non-question chatter the copilot never tried to answer produces no gap — only substantive questions the copilot attempted and couldn't ground become gaps.

## Scope Boundaries

**Deferred for later (not v1):**

- Pushing a gap to an external tracker (Trello card / GitHub issue / Jira ticket).
- An automatic close-the-loop check — re-running a gap's question against the updated corpus to auto-resolve or auto-reopen it.
- Capturing a canonical answer / mini-FAQ entry when resolving a gap.
- Live in-meeting gap surfacing (showing "couldn't answer that" during the meeting).
- Email or Slack notification of assignment — in-app only for v1 (no email infrastructure exists yet).
- Capturing the broader set of questions *raised in a meeting but never asked to the copilot*. v1 captures only questions the copilot attempted and couldn't answer.

## Dependencies / Assumptions

- The detection signal exists in two forms already: the synthesis path distinguishes "couldn't ground an answer" (refusal / no retrieval / suppressed-for-grounding), and the rolling summary extracts verbatim unresolved questions. v1 capture builds on the *attempted-but-unanswered* signal.
- An empty `gaps` table already exists in the schema (`supabase/migrations/20260602000000_meeting_events_and_artifacts.sql`) — scaffolded but never written to. It carries verbatim question, context, sources-searched, intent, entities, and confirmed/dismissed flags, but lacks fields for assignment, sections, a full status lifecycle, and frequency/occurrences. The planner should evaluate extending it.
- Semantic merge (R4) and auto-clustering (R7) rely on embeddings; the corpus already uses Voyage embeddings. The similarity threshold for "same question" and the clustering granularity are open (see below).
- Assignment reuses the existing workspace members/roles system (`apps/portal/app/(authed)/members/`). The in-app notification surface is not yet defined.
- Post-meeting assembly runs as a background job at meeting end, alongside the existing meeting-recap Inngest job.

## Success Criteria

- Under auto-capture, the library stays *scannable*: a typical week of meetings yields a deduped, sectioned backlog a manager can read, not a raw flood — dedup collapses repeats and clustering keeps sections coherent.
- The highest-leverage thing to document is obvious — the most-frequently-asked gaps are at the top.
- A gap a manager has organized (renamed section, moved, assigned) is undisturbed when new gaps arrive.
- Marking done / dismissing reliably removes a gap from the open view, and a re-ask brings a closed gap back to attention.

## Outstanding Questions

Deferred to planning:

- The semantic-match threshold for merging "the same question," and the clustering granularity/cadence (how often to re-cluster; how large a section grows before it should split).
- The precise definition and source of a "miss" — which synthesis outcomes count (refusal, zero-hit retrieval, ungrounded-suppression) and whether relevance-gated-out filler is excluded.
- Whether non-manager members can curate/assign, or only resolve gaps assigned to them (R22 assumes the latter for non-managers).
- Where in-app assignment notifications surface for the assignee.
