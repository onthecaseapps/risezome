/**
 * Team-switcher BROWSE LENS for the captures list (U8).
 *
 * The top-bar team switcher writes `CURRENT_TEAM_COOKIE`; absent (or a team the
 * user is no longer on / archived) means the "All meetings" / My-meetings lens —
 * every accessible meeting, unchanged.
 *
 * When a team IS selected, the captures list narrows to meetings that INVOLVE
 * that team: meetings with at least one attendee (`meeting_participants`) who is
 * a member (`team_members`) of the selected team. This lens only NARROWS — it is
 * applied AS A FILTER over the already-RLS-scoped accessible meeting rows, so it
 * can never widen access (RLS scopes `meetings` to attendees ∪ super-admin, U2).
 *
 * This module is the pure, I/O-free filter half so it can be unit-tested. The
 * page owns the one extra query that resolves `involvedMeetingIds` (the
 * meeting_participants ⋈ team_members set, keyed by the accessible meeting_ids +
 * the team_id).
 */

/**
 * Keep only the accessible meetings whose meeting_id is in `involvedMeetingIds`
 * (the set of accessible meetings that involve the selected team). Pure.
 *
 * @param meetings  the already-fetched, already-RLS-scoped accessible rows.
 * @param involvedMeetingIds  meeting_ids (a subset of the accessible ids) that
 *   have ≥1 attendee on the selected team. A `null`/`undefined` value means
 *   "no lens active" (no team selected, or the cookie named a team the user is
 *   no longer on / archived) → return the input unchanged.
 */
export function applyTeamLens<T extends { meeting_id: string }>(
  meetings: T[],
  involvedMeetingIds: ReadonlySet<string> | null | undefined,
): T[] {
  if (involvedMeetingIds === null || involvedMeetingIds === undefined) return meetings;
  return meetings.filter((m) => involvedMeetingIds.has(m.meeting_id));
}
