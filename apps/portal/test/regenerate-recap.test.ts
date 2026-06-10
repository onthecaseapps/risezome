import { describe, it, expect, vi } from 'vitest';
import {
  regenerateRecap,
  type RegenerateRecapDeps,
} from '../app/(authed)/meetings/[meetingId]/review/regenerate-recap-core';

const ORG = 'org-1';
const MEETING = 'meeting-1';

function makeDeps(over: {
  authorized: boolean;
  updateError?: { message: string } | null;
  /** Prior recap_status returned by the SELECT (restored on a failed emit). */
  priorStatus?: string | null;
  sendError?: Error;
}): {
  deps: RegenerateRecapDeps;
  updates: { values: Record<string, unknown>; filters: Record<string, string> }[];
  sent: { name: string; data: { meetingId: string; orgId: string } }[];
} {
  const updates: { values: Record<string, unknown>; filters: Record<string, string> }[] = [];
  const sent: { name: string; data: { meetingId: string; orgId: string } }[] = [];

  const rls = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: over.authorized
                  ? { meeting_id: MEETING, recap_status: over.priorStatus ?? 'done' }
                  : null,
              }),
          }),
        }),
      }),
    }),
  } as unknown as RegenerateRecapDeps['rls'];

  const service = {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, string> = {};
        return {
          eq: (c1: string, v1: string) => {
            filters[c1] = v1;
            return {
              eq: (c2: string, v2: string) => {
                filters[c2] = v2;
                updates.push({ values, filters });
                return Promise.resolve({ error: over.updateError ?? null });
              },
            };
          },
        };
      },
    }),
  } as unknown as RegenerateRecapDeps['service'];

  const send = vi.fn((event: { name: string; data: { meetingId: string; orgId: string } }) => {
    if (over.sendError !== undefined) return Promise.reject(over.sendError);
    sent.push(event);
    return Promise.resolve(undefined);
  }) as unknown as RegenerateRecapDeps['send'];

  return { deps: { orgId: ORG, rls, service, send }, updates, sent };
}

describe('regenerateRecap (U6)', () => {
  it('authorized: flips status to generating (org-scoped) and emits the event once', async () => {
    const { deps, updates, sent } = makeDeps({ authorized: true });
    const result = await regenerateRecap(deps, MEETING);

    expect(result).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toEqual({ recap_status: 'generating' });
    expect(updates[0]?.filters).toEqual({ meeting_id: MEETING, org_id: ORG });
    expect(sent).toEqual([
      { name: 'risezome/meeting.recap-requested', data: { meetingId: MEETING, orgId: ORG } },
    ]);
  });

  it('unauthorized (RLS hides the meeting): no write, no event', async () => {
    const { deps, updates, sent } = makeDeps({ authorized: false });
    const result = await regenerateRecap(deps, MEETING);

    expect(result).toEqual({ ok: false, error: 'not_authorized' });
    expect(updates).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('does not emit when the status write fails', async () => {
    const { deps, sent } = makeDeps({ authorized: true, updateError: { message: 'db down' } });
    const result = await regenerateRecap(deps, MEETING);

    expect(result).toEqual({ ok: false, error: 'db down' });
    expect(sent).toHaveLength(0);
  });

  it('restores the prior recap_status when the emit throws (no permanent "Generating…" wedge)', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, updates } = makeDeps({
        authorized: true,
        priorStatus: 'failed',
        sendError: new Error('inngest unreachable'),
      });
      const result = await regenerateRecap(deps, MEETING);

      expect(result).toEqual({ ok: false, error: 'recap_request_failed' });
      // First write flips to generating; second write rolls back to the prior
      // status captured from the SELECT — not left wedged on 'generating'.
      expect(updates).toHaveLength(2);
      expect(updates[0]?.values).toEqual({ recap_status: 'generating' });
      expect(updates[1]?.values).toEqual({ recap_status: 'failed' });
      expect(updates[1]?.filters).toEqual({ meeting_id: MEETING, org_id: ORG });
    } finally {
      consoleErr.mockRestore();
    }
  });
});
