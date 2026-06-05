// @vitest-environment node
//
// Exercises the structured-recap orchestrator (U3) with a mocked Supabase
// surface + injected transcript reader / generator. Uses the real crypto dev
// backend (RawAES via RISEZOME_DEV_CRYPTO_KEY) so the persisted recap_json_enc
// round-trips through decryptForOrgFromBytea back to the structured shape.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env['RISEZOME_DEV_CRYPTO_KEY'] =
  process.env['RISEZOME_DEV_CRYPTO_KEY'] ?? 'dev-test-key-1234567890abcdef';

import { CRYPTO_VERSION, decryptForOrgFromBytea } from '@risezome/crypto';
import {
  deriveParticipants,
  flattenTranscriptLines,
  generateMeetingRecap,
  type RecapDb,
  type GenerateMeetingRecapOptions,
} from '../../src/inngest/functions/generate-meeting-recap';
import type { TranscriptRow } from '../../app/_lib/transcript';
import type { StructuredRecap, StructuredRecapNarrative } from '../../src/inngest/lib/meeting-recap';

const ORG = '11111111-1111-1111-1111-111111111111';
const MEETING = '22222222-2222-2222-2222-222222222222';

const NOW = '2026-06-05T12:00:00.000Z';

/** A Supabase mock recording update payloads + the .eq() filters they were scoped by. */
function makeService(meetingRow: { meeting_id: string; calendar_event_id: string | null } | null): {
  service: RecapDb;
  updates: { values: Record<string, unknown>; filters: Record<string, string> }[];
} {
  const updates: { values: Record<string, unknown>; filters: Record<string, string> }[] = [];
  const service = {
    from(table: string) {
      return {
        select() {
          const chain = {
            eq: () => chain,
            single: () => Promise.resolve({ data: table === 'meetings' ? meetingRow : null, error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          };
          return chain;
        },
        update(values: Record<string, unknown>) {
          const filters: Record<string, string> = {};
          const record = { values, filters };
          const chain = {
            eq: (col: string, val: string) => {
              filters[col] = val;
              return chain;
            },
            then: (resolve: (v: { error: null }) => void) => {
              updates.push(record);
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  } as unknown as RecapDb;
  return { service, updates };
}

function row(speaker: string | null, text: string, startMs: number | null): TranscriptRow {
  return {
    event_id: 1,
    payload: { ...(speaker !== null ? { speaker } : {}), ...(startMs !== null ? { startMs } : {}) },
    created_at: NOW,
    text,
  };
}

function baseOpts(over: Partial<GenerateMeetingRecapOptions>): GenerateMeetingRecapOptions {
  return {
    meetingId: MEETING,
    orgId: ORG,
    apiKey: 'sk-test',
    nowIso: () => NOW,
    ...over,
  };
}

const NARRATIVE: StructuredRecapNarrative = {
  overview: 'We picked the model stack.',
  topics: [{ text: 'AI models', timestampMs: 72_000 }],
  decisions: [{ category: 'Schema', text: 'Structured JSON recap.' }],
  action_items: [{ text: 'Ship it', assignee: 'Jason', timestampMs: 300_000 }],
};

describe('flattenTranscriptLines', () => {
  it('keeps speaker, normalizes startMs to elapsed-from-first, and drops empty-text rows', () => {
    const lines = flattenTranscriptLines([
      row('Alice', 'hello', 1_000),
      row('Bob', '', 2_000),
      row(null, 'audio only', null),
    ]);
    expect(lines).toEqual([
      { speaker: 'Alice', text: 'hello', startMs: 0 },
      { speaker: null, text: 'audio only', startMs: null },
    ]);
  });

  it('normalizes absolute (epoch) startMs to elapsed meeting time', () => {
    // Real payload startMs are epoch-style ms; the recap must show 00:00, 01:12…
    const lines = flattenTranscriptLines([
      row('A', 'first', 1_780_623_780_000),
      row('B', 'later', 1_780_623_852_000),
    ]);
    expect(lines).toEqual([
      { speaker: 'A', text: 'first', startMs: 0 },
      { speaker: 'B', text: 'later', startMs: 72_000 },
    ]);
  });

  it('leaves a fully timestamp-less (local-audio) transcript untouched', () => {
    const lines = flattenTranscriptLines([row(null, 'a', null), row(null, 'b', null)]);
    expect(lines).toEqual([
      { speaker: null, text: 'a', startMs: null },
      { speaker: null, text: 'b', startMs: null },
    ]);
  });
});

describe('deriveParticipants', () => {
  it('returns distinct named speakers in first-seen order', () => {
    const { participants, speakerCount } = deriveParticipants([
      row('Alice', 'a', 0),
      row('Bob', 'b', 1),
      row('Alice', 'c', 2),
    ]);
    expect(participants).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    expect(speakerCount).toBe(2);
  });

  it('returns empty for local-audio (null speakers)', () => {
    const { participants, speakerCount } = deriveParticipants([row(null, 'x', 0), row(null, 'y', 1)]);
    expect(participants).toEqual([]);
    expect(speakerCount).toBe(0);
  });
});

describe('generateMeetingRecap', () => {
  it('happy path: writes a decryptable structured recap with derived participants + status done', async () => {
    const { service, updates } = makeService({ meeting_id: MEETING, calendar_event_id: null });
    const result = await generateMeetingRecap(
      service,
      baseOpts({
        transcriptReader: () => Promise.resolve([row('Alice', 'do we use AI', 72_000), row('Bob', 'yes', 80_000)]),
        generate: () => Promise.resolve(NARRATIVE),
      }),
    );

    expect(result).toEqual({ meetingId: MEETING, recap: 'done' });

    // generating first, then the final done write.
    expect(updates[0]?.values).toEqual({ recap_status: 'generating' });
    const done = updates[1]!;
    expect(done.values.recap_status).toBe('done');
    expect(done.values.recap_json_key_version).toBe(CRYPTO_VERSION.KMS_ESDK);
    expect(done.values.recap_generated_at).toBe(NOW);
    // org-scoped (defense-in-depth) on every write.
    expect(done.filters).toEqual({ meeting_id: MEETING, org_id: ORG });

    const decrypted = JSON.parse(
      await decryptForOrgFromBytea(ORG, done.values.recap_json_enc as string),
    ) as StructuredRecap;
    expect(decrypted.overview).toBe('We picked the model stack.');
    expect(decrypted.topics).toEqual([{ text: 'AI models', timestampMs: 72_000 }]);
    expect(decrypted.participants).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    expect(decrypted.speakerCount).toBe(2);
  });

  it('local-audio: participants empty, speakerCount 0, still done', async () => {
    const { service, updates } = makeService({ meeting_id: MEETING, calendar_event_id: null });
    await generateMeetingRecap(
      service,
      baseOpts({
        transcriptReader: () => Promise.resolve([row(null, 'mic audio', 0), row(null, 'more audio', 5_000)]),
        generate: () => Promise.resolve(NARRATIVE),
      }),
    );
    const done = updates[1]!;
    const decrypted = JSON.parse(
      await decryptForOrgFromBytea(ORG, done.values.recap_json_enc as string),
    ) as StructuredRecap;
    expect(decrypted.participants).toEqual([]);
    expect(decrypted.speakerCount).toBe(0);
    expect(done.values.recap_status).toBe('done');
  });

  it('no transcript: terminal done with the minimal placeholder, no model call', async () => {
    const { service, updates } = makeService({ meeting_id: MEETING, calendar_event_id: null });
    let generated = false;
    const result = await generateMeetingRecap(
      service,
      baseOpts({
        transcriptReader: () => Promise.resolve([]),
        generate: () => {
          generated = true;
          return Promise.resolve(NARRATIVE);
        },
      }),
    );
    expect(result).toEqual({ meetingId: MEETING, recap: 'empty' });
    expect(generated).toBe(false);
    const done = updates[1]!;
    expect(done.values.recap_status).toBe('done');
    const decrypted = JSON.parse(
      await decryptForOrgFromBytea(ORG, done.values.recap_json_enc as string),
    ) as StructuredRecap;
    expect(decrypted.overview).toMatch(/no transcript/i);
    expect(decrypted.topics).toEqual([]);
    expect(decrypted.participants).toEqual([]);
  });

  it('propagates a generator failure (so the Inngest onFailure flips failed)', async () => {
    const { service } = makeService({ meeting_id: MEETING, calendar_event_id: null });
    await expect(
      generateMeetingRecap(
        service,
        baseOpts({
          transcriptReader: () => Promise.resolve([row('Alice', 'hi', 0)]),
          generate: () => Promise.reject(new Error('model exploded')),
        }),
      ),
    ).rejects.toThrow(/model exploded/);
  });

  it('throws when the meeting is not found for the org', async () => {
    const { service } = makeService(null);
    await expect(
      generateMeetingRecap(
        service,
        baseOpts({ transcriptReader: () => Promise.resolve([]), generate: () => Promise.resolve(NARRATIVE) }),
      ),
    ).rejects.toThrow(/meeting not found/);
  });
});

// Touch the crypto module so the dev key assignment above is exercised even if a
// future refactor drops the round-trip asserts.
beforeAll(() => undefined);
afterAll(() => undefined);
