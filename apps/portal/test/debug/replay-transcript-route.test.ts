// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  class Env extends Error {}
  return {
    orgId: 'org_1',
    rows: [] as { event_id: number; payload: Record<string, unknown> | null; created_at: string; text: string | null }[],
    throwCrypto: false,
    Env,
  };
});

vi.mock('../../app/_lib/auth', () => ({
  requireAuthedUserWithOrg: () => Promise.resolve({ orgId: h.orgId }),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServerClient: () => Promise.resolve({}),
}));
vi.mock('@risezome/crypto', () => ({ EnvelopeCryptoError: h.Env }));
vi.mock('../../app/_lib/transcript', () => ({
  transcriptWithText: () =>
    h.throwCrypto ? Promise.reject(new h.Env('kms down')) : Promise.resolve(h.rows),
}));

import { GET } from '../../app/api/debug/replay-transcript/route';

function get(meetingId?: string): Request {
  const q = meetingId !== undefined ? `?meetingId=${meetingId}` : '';
  return new Request(`http://localhost/api/debug/replay-transcript${q}`);
}

describe('GET /api/debug/replay-transcript', () => {
  beforeEach(() => {
    h.throwCrypto = false;
    h.rows = [
      { event_id: 2, payload: { utteranceId: 'b', speaker: 'S1', startMs: 5000 }, created_at: '', text: 'second' },
      { event_id: 1, payload: { utteranceId: 'a', speaker: 'S0', startMs: 1000 }, created_at: '', text: 'first' },
    ];
  });

  it('returns ordered replay utterances for a meeting', async () => {
    const res = await GET(get('m1'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; utterances: { utteranceId: string; startMs: number }[] };
    expect(json.ok).toBe(true);
    expect(json.utterances.map((u) => u.utteranceId)).toEqual(['a', 'b']); // sorted by startMs
  });

  it('400s when meetingId is missing', async () => {
    const res = await GET(get());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('missing_meeting_id');
  });

  it('degrades to a typed 500 on a decrypt failure (no leak)', async () => {
    h.throwCrypto = true;
    const res = await GET(get('m1'));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('transcript_decrypt_failed');
  });
});
