import { describe, expect, it } from 'vitest';
import { isMasterKeyAccess } from '../app/_lib/meeting-access';

/**
 * Pure-function unit test for the master-key-access predicate (U5 Part B; KTD5).
 *
 * isMasterKeyAccess is the boolean decision behind the app-layer master-key audit:
 * "is THIS super_admin view an access only the master key grants?" — true only for
 * a non-owner super_admin on a meeting they are not otherwise entitled to (only_me,
 * or only_participants where they did not participate). Everything else is false.
 */

const SA = 'super-admin-user';
const OWNER = 'owner-user';

describe('isMasterKeyAccess', () => {
  it('non-super_admin roles are never a master-key access', () => {
    for (const role of ['member', 'manager'] as const) {
      expect(
        isMasterKeyAccess({
          role,
          viewerId: SA,
          ownerId: OWNER,
          privacyLevel: 'only_me',
          isParticipant: false,
        }),
      ).toBe(false);
    }
  });

  it('the owner viewing their own meeting is never a master-key access', () => {
    expect(
      isMasterKeyAccess({
        role: 'super_admin',
        viewerId: OWNER,
        ownerId: OWNER,
        privacyLevel: 'only_me',
        isParticipant: false,
      }),
    ).toBe(false);
  });

  it('non-owner super_admin on only_me IS a master-key access', () => {
    expect(
      isMasterKeyAccess({
        role: 'super_admin',
        viewerId: SA,
        ownerId: OWNER,
        privacyLevel: 'only_me',
        isParticipant: false,
      }),
    ).toBe(true);
  });

  it('non-owner super_admin on only_participants is master-key ONLY when not a participant', () => {
    expect(
      isMasterKeyAccess({
        role: 'super_admin',
        viewerId: SA,
        ownerId: OWNER,
        privacyLevel: 'only_participants',
        isParticipant: false,
      }),
    ).toBe(true);
    // A participating super_admin is entitled as a participant — not master-key.
    expect(
      isMasterKeyAccess({
        role: 'super_admin',
        viewerId: SA,
        ownerId: OWNER,
        privacyLevel: 'only_participants',
        isParticipant: true,
      }),
    ).toBe(false);
  });

  it('only_teammates is entitled to every org member — never a master-key access', () => {
    expect(
      isMasterKeyAccess({
        role: 'super_admin',
        viewerId: SA,
        ownerId: OWNER,
        privacyLevel: 'only_teammates',
        isParticipant: false,
      }),
    ).toBe(false);
  });
});

/**
 * P1-B: the captures library list EXCLUDES master-key-only meetings for a
 * super_admin (so a restricted recap is never decrypted/rendered without an audit
 * row — only the review/live detail pages audit). The page filters with
 * `!isMasterKeyAccess(...)`; this asserts that exact filter over a mixed row set,
 * mirroring captures/page.tsx so a regression in the predicate is caught here.
 */
describe('captures list exclusion (super_admin)', () => {
  type Row = { id: string; ownerId: string; privacyLevel: string; isParticipant: boolean };

  const rows: Row[] = [
    { id: 'own_only_me', ownerId: SA, privacyLevel: 'only_me', isParticipant: false }, // owns → keep
    { id: 'other_only_me', ownerId: OWNER, privacyLevel: 'only_me', isParticipant: false }, // master-key → exclude
    { id: 'part_only_participants', ownerId: OWNER, privacyLevel: 'only_participants', isParticipant: true }, // attended → keep
    { id: 'notpart_only_participants', ownerId: OWNER, privacyLevel: 'only_participants', isParticipant: false }, // not attended → exclude
    { id: 'teammates', ownerId: OWNER, privacyLevel: 'only_teammates', isParticipant: false }, // entitled → keep
  ];

  function visibleTo(role: 'member' | 'manager' | 'super_admin'): string[] {
    return rows
      .filter(
        (r) =>
          !isMasterKeyAccess({
            role,
            viewerId: SA,
            ownerId: r.ownerId,
            privacyLevel: r.privacyLevel,
            isParticipant: r.isParticipant,
          }),
      )
      .map((r) => r.id);
  }

  it('a super_admin list excludes the restricted not-attended meetings (only_me, non-participant only_participants)', () => {
    const visible = visibleTo('super_admin');
    expect(visible).not.toContain('other_only_me');
    expect(visible).not.toContain('notpart_only_participants');
    // But keeps the ones it is genuinely entitled to.
    expect(visible).toEqual([
      'own_only_me',
      'part_only_participants',
      'teammates',
    ]);
  });

  it('non-super_admin behavior is unchanged — the filter is a no-op (RLS already scopes their rows)', () => {
    // isMasterKeyAccess is false for non-super_admins, so the captures filter keeps
    // every row RLS handed them.
    expect(visibleTo('manager')).toEqual(rows.map((r) => r.id));
    expect(visibleTo('member')).toEqual(rows.map((r) => r.id));
  });
});
