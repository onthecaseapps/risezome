import { describe, it, expect } from 'vitest';
import { applyTeamLens } from '../app/(authed)/captures/_team-lens';

/**
 * U8 — captures team-switcher BROWSE LENS (pure filter half).
 *
 * `applyTeamLens` narrows the already-RLS-scoped accessible meeting rows to the
 * ones that involve the selected team (the `involvedMeetingIds` set the page
 * resolves from meeting_participants ⋈ team_members). The lens MUST only narrow,
 * never widen — and "no lens" (no team selected / stale / archived cookie ⇒
 * null) must pass the input through unchanged.
 */

type Row = { meeting_id: string; title: string };

const rows: Row[] = [
  { meeting_id: 'a', title: 'Alpha' },
  { meeting_id: 'b', title: 'Beta' },
  { meeting_id: 'c', title: 'Gamma' },
];

describe('applyTeamLens (U8 captures browse lens)', () => {
  it('no lens (null) returns the accessible rows unchanged', () => {
    expect(applyTeamLens(rows, null)).toEqual(rows);
  });

  it('no lens (undefined) returns the accessible rows unchanged', () => {
    expect(applyTeamLens(rows, undefined)).toEqual(rows);
  });

  it('keeps only meetings whose id is in the involved set', () => {
    const out = applyTeamLens(rows, new Set(['a', 'c']));
    expect(out.map((r) => r.meeting_id)).toEqual(['a', 'c']);
  });

  it('an empty involved set hides everything (team with no involved accessible meetings)', () => {
    expect(applyTeamLens(rows, new Set())).toEqual([]);
  });

  it('never widens: ids in the involved set but NOT accessible are not invented', () => {
    // 'z' is "involved" but was not in the accessible input → must not appear.
    const out = applyTeamLens(rows, new Set(['a', 'z']));
    expect(out.map((r) => r.meeting_id)).toEqual(['a']);
  });

  it('preserves the order of the accessible input', () => {
    const out = applyTeamLens(rows, new Set(['c', 'a', 'b']));
    expect(out.map((r) => r.meeting_id)).toEqual(['a', 'b', 'c']);
  });
});
