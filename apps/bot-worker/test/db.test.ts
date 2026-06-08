import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control the per-org encryption so we can exercise the success + degrade paths
// without a real KMS. EnvelopeCryptoError is shared with db.ts via the mock so
// the `instanceof` degrade check matches.
const cryptoMock = vi.hoisted(() => {
  class EnvelopeCryptoError extends Error {}
  return { EnvelopeCryptoError, encryptForOrgToBytea: vi.fn() };
});
vi.mock('@risezome/crypto', () => ({
  CRYPTO_VERSION: { KMS_ESDK: 2, LEGACY_PGCRYPTO: 1 },
  encryptForOrgToBytea: cryptoMock.encryptForOrgToBytea,
  EnvelopeCryptoError: cryptoMock.EnvelopeCryptoError,
}));

import { persistAndBroadcast, broadcastOnly, teardownChannelForMeeting } from '../src/db';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Minimal Supabase double: records the inserted meeting_events row and acks
 *  the broadcast channel synchronously. */
interface SentBroadcast {
  channelName: string;
  type: string;
  event: string;
  payload: Record<string, unknown>;
}
function fakeClient(): {
  client: SupabaseClient;
  inserts: Record<string, unknown>[];
  sends: SentBroadcast[];
} {
  const inserts: Record<string, unknown>[] = [];
  const sends: SentBroadcast[] = [];
  const client = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: { event_id: 1 }, error: null }) }) };
        },
      };
    },
    channel(name: string) {
      return {
        subscribe(cb: (s: string) => void) {
          cb('SUBSCRIBED');
          return this;
        },
        send: (msg: { type: string; event: string; payload: Record<string, unknown> }) => {
          sends.push({ channelName: name, ...msg });
          return Promise.resolve('ok');
        },
        unsubscribe: () => Promise.resolve('ok'),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, inserts, sends };
}

const ORG = 'org_1';
let meetingSeq = 0;
function nextMeeting(): string {
  meetingSeq += 1;
  return `mtg_${String(meetingSeq)}`;
}

describe('persistAndBroadcast meeting_events insert', () => {
  beforeEach(() => {
    cryptoMock.encryptForOrgToBytea.mockReset();
  });
  afterEach(async () => {
    // Drop pooled channels so each test gets a fresh subscribe.
    for (let i = 1; i <= meetingSeq; i++) {
      await teardownChannelForMeeting(fakeClient().client, ORG, `mtg_${String(i)}`).catch(() => undefined);
    }
  });

  it('OMITS transcript_key_version for a non-transcript event (lets the NOT NULL default apply)', async () => {
    const { client, inserts } = fakeClient();
    const meetingId = nextMeeting();
    await persistAndBroadcast(client, { meetingId, orgId: ORG, type: 'card', payload: { card: { id: 'c1' } } });

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    // Writing an explicit null here would violate meeting_events.transcript_key_version
    // (int NOT NULL default 1) and drop the event — the column must be ABSENT.
    expect('transcript_key_version' in row).toBe(false);
    expect('transcript_text_enc' in row).toBe(false);
    expect(cryptoMock.encryptForOrgToBytea).not.toHaveBeenCalled();
  });

  it('stamps version 2 + encrypted text for a transcript event, and drops plaintext from the payload', async () => {
    cryptoMock.encryptForOrgToBytea.mockResolvedValue('\\xDEADBEEF');
    const { client, inserts } = fakeClient();
    const meetingId = nextMeeting();
    await persistAndBroadcast(client, {
      meetingId,
      orgId: ORG,
      type: 'transcript.data',
      payload: { text: 'hello world', utteranceId: 'u1', speaker: 'A' },
    });

    const row = inserts[0]!;
    expect(row.transcript_text_enc).toBe('\\xDEADBEEF');
    expect(row.transcript_key_version).toBe(2);
    // Plaintext text is NOT persisted; speaker/ids stay for stats.
    expect((row.payload as Record<string, unknown>).text).toBeUndefined();
    expect((row.payload as Record<string, unknown>).utteranceId).toBe('u1');
  });

  it('DEGRADES (omits both columns) when transcript encryption fails — row still lands', async () => {
    cryptoMock.encryptForOrgToBytea.mockRejectedValue(new cryptoMock.EnvelopeCryptoError('kms down'));
    const { client, inserts } = fakeClient();
    const meetingId = nextMeeting();
    const res = await persistAndBroadcast(client, {
      meetingId,
      orgId: ORG,
      type: 'transcript.data',
      payload: { text: 'secret', utteranceId: 'u2' },
    });

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    // Degrade: no ciphertext, and the column is OMITTED so the default (1) applies
    // rather than an explicit null that would violate NOT NULL and drop the row.
    expect('transcript_text_enc' in row).toBe(false);
    expect('transcript_key_version' in row).toBe(false);
    expect(res.eventId).toBe(1);
  });
});

describe('broadcastOnly (transient — no DB write)', () => {
  afterEach(async () => {
    for (let i = 1; i <= meetingSeq; i++) {
      await teardownChannelForMeeting(fakeClient().client, ORG, `mtg_${String(i)}`).catch(() => undefined);
    }
  });

  it('sends on the meeting channel with the event+payload and inserts NOTHING', async () => {
    const { client, inserts, sends } = fakeClient();
    const meetingId = nextMeeting();
    const payload = { utteranceId: 'u1', text: 'how many', isFinal: false, revision: 3 };
    const res = await broadcastOnly(client, {
      meetingId,
      orgId: ORG,
      type: 'transcript.partial_data',
      payload,
    });

    // Transient: no meeting_events row, no encryption.
    expect(inserts).toHaveLength(0);
    // Broadcast on the right private channel, with the partial event + payload
    // passed THROUGH untouched (no eventId stamped on, unlike persistAndBroadcast).
    expect(sends).toHaveLength(1);
    const sent = sends[0]!;
    expect(sent.channelName).toBe(`meeting:${ORG}:${meetingId}`);
    expect(sent.type).toBe('broadcast');
    expect(sent.event).toBe('transcript.partial_data');
    expect(sent.payload).toEqual(payload);
    expect('eventId' in sent.payload).toBe(false);
    expect(res.broadcasted).toBe(true);
  });
});
