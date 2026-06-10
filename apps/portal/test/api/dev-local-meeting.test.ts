// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn((_e: unknown) => Promise.resolve()),
  responses: {
    meetingInsert: { data: { meeting_id: 'm_new' }, error: null } as { data: unknown; error: unknown },
    meetingUpdate: { data: [{ meeting_id: 'm1' }], error: null } as { data: unknown; error: unknown },
    orgsList: { data: [{ id: 'o1', name: 'Org One' }, { id: 'o2', name: 'Org Two' }], error: null } as { data: unknown; error: unknown },
    org: { data: { id: 'org_fallback' } } as { data: unknown },
    member: { data: { user_id: 'user_fallback' } } as { data: unknown },
    captured: { insert: null as unknown, update: null as unknown, participant: null as unknown },
  },
}));

vi.mock('../../src/inngest/client', () => ({ inngest: { send: h.send } }));

vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      let mode: 'select' | 'insert' | 'update' = 'select';
      const b = {
        insert(row: unknown) {
          mode = 'insert';
          if (table === 'meetings') h.responses.captured.insert = row;
          if (table === 'meeting_participants') h.responses.captured.participant = row;
          return b;
        },
        update(row: unknown) {
          mode = 'update';
          if (table === 'meetings') h.responses.captured.update = row;
          return b;
        },
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () => b,
        single: () =>
          Promise.resolve(
            table === 'meetings' && mode === 'insert' ? h.responses.meetingInsert : { data: null, error: null },
          ),
        maybeSingle: () =>
          Promise.resolve(
            table === 'orgs' ? h.responses.org : table === 'org_members' ? h.responses.member : { data: null },
          ),
        // Awaitable for the update().select() and orgs-list paths.
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === 'meetings' && mode === 'update'
              ? h.responses.meetingUpdate
              : table === 'orgs' && mode === 'select'
                ? h.responses.orgsList
                : { data: null, error: null },
          ),
      };
      return b;
    },
  }),
}));

import { POST } from '../../app/api/dev/local-meeting/route';

function post(body: unknown, auth: string | null = 'Bearer test-secret'): Request {
  return new Request('http://localhost/api/dev/local-meeting', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth !== null ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('dev local-meeting API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.responses.captured.insert = null;
    h.responses.captured.update = null;
    h.responses.captured.participant = null;
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BOT_WORKER_SECRET', 'test-secret');
    vi.stubEnv('RISEZOME_DEV_ORG_ID', 'org_env');
    vi.stubEnv('RISEZOME_DEV_USER_ID', 'user_env');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('start mints a recording meeting in the dev org with a Local-meeting title and null flags', async () => {
    const res = await POST(post({ action: 'start' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; meetingId: string; orgId: string };
    expect(json).toMatchObject({ ok: true, meetingId: 'm_new', orgId: 'org_env' });
    const inserted = h.responses.captured.insert as Record<string, unknown>;
    expect(inserted.org_id).toBe('org_env');
    expect(inserted.user_id).toBe('user_env');
    expect(inserted.status).toBe('recording');
    expect(String(inserted.title)).toMatch(/^Local meeting /);
    expect(inserted.conference_url).toBeUndefined(); // left null (flag, KTD3)
    expect(inserted.calendar_event_id).toBeUndefined();
    // The dev user is registered as a participant so the participant-scoped
    // meetings RLS policy lets the live page read it (else 404 despite org match).
    expect(h.responses.captured.participant).toEqual({ meeting_id: 'm_new', user_id: 'user_env' });
  });

  it('stop completes the meeting and fires BOTH recap + gaps jobs (KTD4)', async () => {
    const res = await POST(post({ action: 'stop', meetingId: 'm1', orgId: 'org_env' }));
    expect(res.status).toBe(200);
    const updated = h.responses.captured.update as Record<string, unknown>;
    expect(updated.status).toBe('completed');
    expect(typeof updated.ended_at).toBe('string');
    expect(h.send).toHaveBeenCalledTimes(2);
    const events = h.send.mock.calls.map((c) => c[0] as { name: string; data: unknown });
    expect(events.map((e) => e.name).sort()).toEqual([
      'risezome/meeting.gaps-requested',
      'risezome/meeting.recap-requested',
    ]);
    for (const e of events) expect(e.data).toEqual({ meetingId: 'm1', orgId: 'org_env' });
  });

  it('lists orgs (+ the configured default) for the dev console picker', async () => {
    const res = await POST(post({ action: 'orgs' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; orgs: { id: string }[]; defaultOrgId: string | null };
    expect(json.ok).toBe(true);
    expect(json.orgs.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(json.defaultOrgId).toBe('org_env'); // from RISEZOME_DEV_ORG_ID
  });

  it('start honors an explicit orgId override (the picked org)', async () => {
    const res = await POST(post({ action: 'start', orgId: 'picked-org' }));
    expect(res.status).toBe(200);
    expect((h.responses.captured.insert as Record<string, unknown>).org_id).toBe('picked-org');
  });

  it('is 404 in production (dev-only, KTD6)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(post({ action: 'start' }));
    expect(res.status).toBe(404);
  });

  it('is 404 without the dev-tooling bearer (defense-in-depth beyond NODE_ENV)', async () => {
    const res = await POST(post({ action: 'orgs' }, null));
    expect(res.status).toBe(404);
  });

  it('is 404 with a WRONG bearer', async () => {
    const res = await POST(post({ action: 'orgs' }, 'Bearer wrong-secret'));
    expect(res.status).toBe(404);
  });

  it('is 404 when no secret is configured (fail closed)', async () => {
    vi.stubEnv('BOT_WORKER_SECRET', '');
    const res = await POST(post({ action: 'orgs' }));
    expect(res.status).toBe(404);
  });

  it('stop on an unknown/foreign-org meeting is a 404 and fires no jobs', async () => {
    h.responses.meetingUpdate = { data: [], error: null }; // 0 rows updated
    const res = await POST(post({ action: 'stop', meetingId: 'nope', orgId: 'org_env' }));
    expect(res.status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
    h.responses.meetingUpdate = { data: [{ meeting_id: 'm1' }], error: null }; // restore
  });

  it('stop requires meetingId + orgId', async () => {
    const res = await POST(post({ action: 'stop' }));
    expect(res.status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('start falls back to the oldest org + member when env vars are unset', async () => {
    vi.stubEnv('RISEZOME_DEV_ORG_ID', '');
    vi.stubEnv('RISEZOME_DEV_USER_ID', '');
    const res = await POST(post({ action: 'start' }));
    expect(res.status).toBe(200);
    const inserted = h.responses.captured.insert as Record<string, unknown>;
    expect(inserted.org_id).toBe('org_fallback');
    expect(inserted.user_id).toBe('user_fallback');
  });
});
