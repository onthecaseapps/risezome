import { describe, expect, it } from 'vitest';
import { CURRENT_ORG_COOKIE } from '../../app/_lib/auth';

/**
 * Smoke tests for the onboarding/createOrg server action.
 *
 * Most of createOrg's logic depends on a real Supabase project + auth
 * session, which is covered by the manual e2e during dev. These tests
 * lock in the constants + cookie naming the action depends on so a future
 * refactor doesn't drift them out of sync with the consumers.
 */
describe('createOrg action contract', () => {
  it('CURRENT_ORG_COOKIE name is stable', () => {
    // If this changes, every authed page's requireAuthedUserWithOrg()
    // breaks silently (cookie read returns undefined, falls back to first
    // membership) which would silently switch active orgs on next request.
    expect(CURRENT_ORG_COOKIE).toBe('risezome.current_org_id');
  });

  it('CURRENT_ORG_COOKIE matches the namespace prefix used elsewhere', () => {
    // All Risezome-owned cookies should be prefixed `risezome.` so they're
    // distinguishable from Supabase / Next.js / third-party cookies in the
    // browser DevTools and in any future cookie inventory work.
    expect(CURRENT_ORG_COOKIE).toMatch(/^risezome\./);
  });
});
