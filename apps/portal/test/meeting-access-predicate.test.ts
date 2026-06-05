import { describe, expect, it } from 'vitest';
import { isMasterKeyAccess } from '../app/_lib/meeting-access';

/**
 * Pure-function unit test for the master-key-access predicate (teams restructure U2).
 *
 * Access is attendees-only. isMasterKeyAccess is the boolean behind the app-layer
 * master-key audit: "is THIS super_admin view an access only the master key grants?"
 * — true only for a super_admin who neither owns nor attended the meeting.
 */

const SA = 'super-admin-user';
const OWNER = 'owner-user';

describe('isMasterKeyAccess', () => {
  it('non-super_admin roles are never a master-key access', () => {
    for (const role of ['member', 'manager'] as const) {
      expect(
        isMasterKeyAccess({ role, viewerId: SA, ownerId: OWNER, isParticipant: false }),
      ).toBe(false);
    }
  });

  it('the owner viewing their own meeting is never a master-key access', () => {
    expect(
      isMasterKeyAccess({ role: 'super_admin', viewerId: OWNER, ownerId: OWNER, isParticipant: false }),
    ).toBe(false);
  });

  it('a non-owner super_admin who did NOT attend IS a master-key access', () => {
    expect(
      isMasterKeyAccess({ role: 'super_admin', viewerId: SA, ownerId: OWNER, isParticipant: false }),
    ).toBe(true);
  });

  it('a non-owner super_admin who attended is entitled — NOT a master-key access', () => {
    expect(
      isMasterKeyAccess({ role: 'super_admin', viewerId: SA, ownerId: OWNER, isParticipant: true }),
    ).toBe(false);
  });
});

/**
 * The captures library list EXCLUDES master-key-only meetings for a super_admin (so
 * a restricted recap is never decrypted/rendered without an audit row — only the
 * review/live detail pages audit). The page filters with `!isMasterKeyAccess(...)`;
 * this asserts that exact filter over a mixed row set, mirroring captures/page.tsx so
 * a regression in the predicate is caught here.
 */
describe('captures list exclusion (super_admin)', () => {
  type Row = { id: string; ownerId: string; isParticipant: boolean };

  const rows: Row[] = [
    { id: 'own', ownerId: SA, isParticipant: false },          // owns → keep
    { id: 'attended', ownerId: OWNER, isParticipant: true },   // attended → keep
    { id: 'not_attended', ownerId: OWNER, isParticipant: false }, // master-key → exclude
  ];

  function visibleTo(role: 'member' | 'manager' | 'super_admin'): string[] {
    return rows
      .filter(
        (r) =>
          !isMasterKeyAccess({
            role,
            viewerId: SA,
            ownerId: r.ownerId,
            isParticipant: r.isParticipant,
          }),
      )
      .map((r) => r.id);
  }

  it('a super_admin list excludes the not-owned, not-attended meeting', () => {
    const visible = visibleTo('super_admin');
    expect(visible).not.toContain('not_attended');
    expect(visible).toEqual(['own', 'attended']);
  });

  it('non-super_admin behavior is unchanged — the filter is a no-op (RLS already scopes their rows)', () => {
    expect(visibleTo('manager')).toEqual(rows.map((r) => r.id));
    expect(visibleTo('member')).toEqual(rows.map((r) => r.id));
  });
});
