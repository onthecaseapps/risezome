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
