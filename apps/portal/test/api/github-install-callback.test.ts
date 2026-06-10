// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SECURITY regression for the GitHub install-callback claim guard. Both refusal
 * paths short-circuit BEFORE the GitHub fetch, so we only model the two table
 * reads they touch (pending_installations + github_installations). The guard
 * must refuse to adopt:
 *   - an installation already CLAIMED by a different org, and
 *   - a STALE unclaimed (org_id NULL) skeleton (the cross-tenant adoption hole).
 */

const h = vi.hoisted(() => ({
  // What the github_installations claim-lookup `.maybeSingle()` returns.
  claimRow: null as { org_id: string | null; installed_at: string } | null,
  octokitCalled: false,
}));

vi.mock('../../app/_lib/github-app', () => ({
  getInstallationOctokit: () => {
    h.octokitCalled = true;
    throw new Error('octokit must not be reached when the claim is refused');
  },
}));

vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.delete = () => b;
      b.insert = () => Promise.resolve({ error: null });
      b.maybeSingle = () => {
        if (table === 'pending_installations') {
          // Valid, unexpired state bound to the caller's org.
          return Promise.resolve({
            data: { org_id: 'attacker-org', user_id: 'u1', expires_at: new Date(Date.now() + 60_000).toISOString() },
            error: null,
          });
        }
        if (table === 'github_installations') {
          return Promise.resolve({ data: h.claimRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      // pending_installations delete is awaited without maybeSingle.
      b.then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
      return b;
    },
  }),
}));

import { GET } from '../../app/api/github/install-callback/route';

function callbackReq(installationId: number): Request {
  return new Request(
    `https://app.example.com/api/github/install-callback?installation_id=${String(installationId)}&setup_action=install&state=deadbeef`,
  );
}

describe('github install-callback — claim guard', () => {
  beforeEach(() => {
    h.octokitCalled = false;
    h.claimRow = null;
  });

  it('REFUSES adopting an installation already claimed by a different org', async () => {
    h.claimRow = { org_id: 'victim-org', installed_at: new Date().toISOString() };
    const res = await GET(callbackReq(12345) as never);
    expect(res.status).toBe(307); // redirect
    expect(res.headers.get('location')).toContain('error=install_already_claimed');
    expect(h.octokitCalled).toBe(false); // never fetched the victim's repos
  });

  it('REFUSES adopting a STALE unclaimed (org_id NULL) skeleton', async () => {
    // Skeleton created ~30 min ago — outside the 15-min claim window.
    h.claimRow = { org_id: null, installed_at: new Date(Date.now() - 30 * 60_000).toISOString() };
    const res = await GET(callbackReq(67890) as never);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=install_already_claimed');
    expect(h.octokitCalled).toBe(false); // the enumerate-abandoned-skeletons attack is blocked
  });
});
