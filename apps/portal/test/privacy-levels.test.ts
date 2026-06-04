import { describe, expect, it } from 'vitest';
import {
  canEditPrivacy,
  privacyOptionsFor,
  toPrivacyLevel,
  type PrivacyLevel,
} from '../app/_lib/privacy-levels';

/**
 * Pure-function unit tests for the privacy-picker floor logic (permissions
 * overhaul U6). `privacyOptionsFor` is the UI mirror of the DB floor trigger
 * (KTD7): it decides which of the three levels a viewer may SELECT, given the org
 * floor + whether they are an admin. Extracted as a pure function so the
 * floor-aware selectability is unit-testable without a component harness.
 */

function selectable(opts: ReturnType<typeof privacyOptionsFor>): PrivacyLevel[] {
  return opts.filter((o) => o.selectable).map((o) => o.level);
}

describe('privacyOptionsFor — non-admin owner is floor-bound', () => {
  it('floor=only_participants disables only_me (more private than the floor)', () => {
    const opts = privacyOptionsFor({
      isAdmin: false,
      floor: 'only_participants',
      currentLevel: 'only_teammates',
    });
    expect(selectable(opts)).toEqual(['only_participants', 'only_teammates']);
    expect(opts.find((o) => o.level === 'only_me')?.selectable).toBe(false);
  });

  it('floor=only_teammates leaves only only_teammates selectable', () => {
    const opts = privacyOptionsFor({
      isAdmin: false,
      floor: 'only_teammates',
      currentLevel: 'only_teammates',
    });
    expect(selectable(opts)).toEqual(['only_teammates']);
  });

  it('floor=only_me (the permissive default) leaves all three selectable', () => {
    const opts = privacyOptionsFor({
      isAdmin: false,
      floor: 'only_me',
      currentLevel: 'only_teammates',
    });
    expect(selectable(opts)).toEqual(['only_me', 'only_participants', 'only_teammates']);
  });

  it('keeps the current level selectable even if it sits below the floor (admin-set)', () => {
    // An admin override may have left the meeting at only_me while the floor is
    // only_participants; the non-admin owner must still see + retain its real level.
    const opts = privacyOptionsFor({
      isAdmin: false,
      floor: 'only_participants',
      currentLevel: 'only_me',
    });
    expect(opts.find((o) => o.level === 'only_me')?.selectable).toBe(true);
  });
});

describe('privacyOptionsFor — admin override is floor-exempt', () => {
  it('an admin can pick every level regardless of the floor', () => {
    const opts = privacyOptionsFor({
      isAdmin: true,
      floor: 'only_teammates',
      currentLevel: 'only_teammates',
    });
    expect(selectable(opts)).toEqual(['only_me', 'only_participants', 'only_teammates']);
  });
});

describe('canEditPrivacy', () => {
  it('owner or admin may edit; a non-owner non-admin may not', () => {
    expect(canEditPrivacy({ isOwner: true, isAdmin: false })).toBe(true);
    expect(canEditPrivacy({ isOwner: false, isAdmin: true })).toBe(true);
    expect(canEditPrivacy({ isOwner: true, isAdmin: true })).toBe(true);
    expect(canEditPrivacy({ isOwner: false, isAdmin: false })).toBe(false);
  });
});

describe('toPrivacyLevel', () => {
  it('passes through valid levels and defaults unknown to only_teammates', () => {
    expect(toPrivacyLevel('only_me')).toBe('only_me');
    expect(toPrivacyLevel('only_participants')).toBe('only_participants');
    expect(toPrivacyLevel('only_teammates')).toBe('only_teammates');
    expect(toPrivacyLevel(null)).toBe('only_teammates');
    expect(toPrivacyLevel('garbage')).toBe('only_teammates');
  });
});
