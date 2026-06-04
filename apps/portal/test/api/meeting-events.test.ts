// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  orgId: 'org_1',
  rows: [] as {
    event_id: number;
    type: string;
    payload: Record<string, unknown> | null;
    transcript_text_enc: string | null;
  }[],
  error: null as { message: string } | null,
}));

vi.mock('../../app/_lib/auth', () => ({
  requireAuthedUserWithOrg: () => Promise.resolve({ orgId: h.orgId }),
}));

vi.mock('../../app/_lib/supabase-server', () => ({
  createServerClient: () => ({
    from() {
      const b = {
        select: () => b,
        eq: () => b,
        gt: () => b,
        order: () => Promise.resolve({ data: h.rows, error: h.error }),
      };
      return b;
    },
  }),
}));

// Decrypt just unwraps a `enc:<text>` sentinel so we can assert the merge.
vi.mock('@risezome/crypto', () => ({
  decryptForOrgFromBytea: (_org: string, enc: string) => Promise.resolve(enc.replace(/^enc:/, '')),
  EnvelopeCryptoError: class EnvelopeCryptoError extends Error {},
}));

import { GET } from '../../app/api/meetings/[meetingId]/events/route';

function get(after?: number): Request {
  const q = after !== undefined ? `?after=${String(after)}` : '';
  return new Request(`http://localhost/api/meetings/m1/events${q}`);
}
const ctx = { params: Promise.resolve({ meetingId: 'm1' }) };

describe('GET /api/meetings/[meetingId]/events', () => {
  beforeEach(() => {
    h.error = null;
    h.rows = [
      { event_id: 10, type: 'card', payload: { card: { id: 'c1' } }, transcript_text_enc: null },
      { event_id: 11, type: 'transcript.data', payload: { utteranceId: 'u1', speaker: 'A' }, transcript_text_enc: 'enc:hello world' },
    ];
  });

  it('merges decrypted text into transcript events and passes others through', async () => {
    const res = await GET(get(5), ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      events: { event_id: number; type: string; payload: Record<string, unknown> }[];
      maxEventId: number;
    };
    expect(json.ok).toBe(true);
    expect(json.maxEventId).toBe(11);
    const transcript = json.events.find((e) => e.type === 'transcript.data');
    // The decrypted text is re-attached for the client reducer (which drops
    // textless transcript events) — this is the whole point of the route.
    expect(transcript?.payload.text).toBe('hello world');
    expect(transcript?.payload.utteranceId).toBe('u1');
    const card = json.events.find((e) => e.type === 'card');
    expect(card?.payload.card).toEqual({ id: 'c1' });
    // transcript_text_enc is NOT leaked to the client.
    expect('transcript_text_enc' in (transcript?.payload ?? {})).toBe(false);
  });

  it('defaults after=0 when the query param is missing/invalid, and echoes it as maxEventId when empty', async () => {
    h.rows = [];
    const res = await GET(get(), ctx);
    const json = (await res.json()) as { ok: boolean; events: unknown[]; maxEventId: number };
    expect(json.events).toHaveLength(0);
    expect(json.maxEventId).toBe(0);
  });

  it('500s on a DB error rather than returning a partial feed', async () => {
    h.error = { message: 'boom' };
    const res = await GET(get(5), ctx);
    expect(res.status).toBe(500);
  });
});
