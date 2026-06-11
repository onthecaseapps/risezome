import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MissRecord } from '@risezome/engine/gaps';
import { createSupabaseSink } from '../../src/pipeline/sink-supabase.js';
import type {
  PipelineCard,
  SynthesisDoneInfo,
  SynthesisRefusalInfo,
  SynthesisRetractInfo,
} from '../../src/pipeline/contract.js';

/**
 * Prod Supabase sink (U2). Characterizes the transport/persistence behavior the
 * shared core routes through this sink: card insert + Realtime broadcast +
 * STALE-CARD RETRACTION, flash-fix synthesis persistence (start/delta/done are
 * the post-grounding broadcasts; refusal/ungrounded insert a retracted row),
 * knowledge-gap miss capture, and ORG-SCOPING (every write carries the caller's
 * org, never a payload-supplied one). recordTrace is intentionally ABSENT.
 */

// ── Mocks for the two transport imports the sink uses ───────────────────

const persistCalls: { type: string; orgId: string; meetingId: string; payload: Record<string, unknown> }[] = [];
vi.mock('../../src/db.js', () => ({
  persistAndBroadcast: vi.fn(
    async (
      _client: SupabaseClient,
      a: { meetingId: string; orgId: string; type: string; payload: Record<string, unknown> },
    ) => {
      persistCalls.push({ type: a.type, orgId: a.orgId, meetingId: a.meetingId, payload: a.payload });
      return { eventId: 1, broadcasted: true };
    },
  ),
}));

vi.mock('@risezome/crypto', () => ({
  CRYPTO_VERSION: { KMS_ESDK: 2 },
  encryptForOrgToBytea: vi.fn(async (_orgId: string, text: string) => `\\xENC(${text})`),
}));

// ── A recording Supabase stub ───────────────────────────────────────────

interface WriteCapture {
  table: string;
  op: 'insert' | 'update' | 'select';
  row?: Record<string, unknown>;
  eq: Record<string, unknown>;
}

/**
 * Builds a SupabaseClient stub that records every insert/update/select with the
 * `.eq(...)` predicates applied (so we can assert org-scoping). `selectResult`
 * supplies the row a `.maybeSingle()` read resolves (used by retraction's pinned
 * lookup).
 */
function recordingDb(selectResult: Record<string, unknown> | null = { pinned: false }): {
  db: SupabaseClient;
  writes: WriteCapture[];
} {
  const writes: WriteCapture[] = [];
  const from = (table: string): unknown => {
    const capture: WriteCapture = { table, op: 'select', eq: {} };
    const chain = {
      insert: (row: Record<string, unknown>) => {
        capture.op = 'insert';
        capture.row = row;
        writes.push(capture);
        return Promise.resolve({ data: null, error: null });
      },
      update: (row: Record<string, unknown>) => {
        capture.op = 'update';
        capture.row = row;
        const updChain = {
          eq: (col: string, val: unknown) => {
            capture.eq[col] = val;
            return updChain;
          },
          is: () => updChain,
          then: (resolve: (v: { data: null; error: null }) => void) => {
            writes.push(capture);
            resolve({ data: null, error: null });
          },
        };
        return updChain;
      },
      select: () => {
        capture.op = 'select';
        const selChain = {
          eq: (col: string, val: unknown) => {
            capture.eq[col] = val;
            return selChain;
          },
          is: () => selChain,
          maybeSingle: () => {
            writes.push(capture);
            return Promise.resolve({ data: selectResult, error: null });
          },
        };
        return selChain;
      },
    };
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, writes };
}

const ORG = 'org_caller';
const MEETING = 'meet_1';
const noopLogger = { info: () => undefined, warn: () => undefined };

function makeCard(over: Partial<PipelineCard> = {}): PipelineCard {
  return {
    docId: 'doc_a',
    source: 'github',
    type: 'issue',
    title: 'Doc A',
    snippet: 'snip',
    body: 'body',
    score: 0.8,
    rank: 0,
    isSummary: false,
    metadata: { distance: 0.4 },
    utteranceId: 'utt_1',
    traceId: 'trace_1',
    ...over,
  };
}

beforeEach(() => {
  persistCalls.length = 0;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('createSupabaseSink — recordTrace absent (prod = trace-free)', () => {
  it('does not define recordTrace, so the core does zero trace work', () => {
    const { db } = recordingDb();
    const sink = createSupabaseSink({
      db,
      meetingId: MEETING,
      orgId: ORG,
      liveCardByDocId: new Map(),
      logger: noopLogger,
    });
    expect(sink.recordTrace).toBeUndefined();
  });
});

describe('emitCard', () => {
  it('inserts an org-scoped cards row, broadcasts the card, returns a cardId', async () => {
    const { db, writes } = recordingDb();
    const live = new Map<string, string>();
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: live, logger: noopLogger });

    const result = await sink.emitCard(makeCard());

    expect(result).not.toBeNull();
    expect(result?.cardId).toMatch(/^card_/);
    const insert = writes.find((w) => w.table === 'cards' && w.op === 'insert');
    expect(insert).toBeDefined();
    // ORG-SCOPING: the row carries the caller's org, not a payload value.
    expect(insert?.row?.org_id).toBe(ORG);
    expect(insert?.row?.meeting_id).toBe(MEETING);
    expect(insert?.row?.trace_id).toBe('trace_1');
    expect(insert?.row?.utterance_id).toBe('utt_1');
    // broadcast carries the caller's org + the card payload.
    const cardBroadcast = persistCalls.find((c) => c.type === 'card');
    expect(cardBroadcast?.orgId).toBe(ORG);
    expect((cardBroadcast?.payload.card as { cardId: string }).cardId).toBe(result?.cardId);
    // The live map now tracks the surfaced card for its doc.
    expect(live.get('doc_a')).toBe(result?.cardId);
  });

  it('returns null (core drops the card as a source) when the insert fails', async () => {
    const from = (_table: string): unknown => ({
      insert: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    });
    const db = { from } as unknown as SupabaseClient;
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: new Map(), logger: noopLogger });
    const result = await sink.emitCard(makeCard());
    expect(result).toBeNull();
  });

  it('retracts the prior live card for the same doc (unless pinned), org-scoped', async () => {
    const { db, writes } = recordingDb({ pinned: false });
    const live = new Map<string, string>([['doc_a', 'card_prior']]);
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: live, logger: noopLogger });

    await sink.emitCard(makeCard({ docId: 'doc_a' }));

    // A retraction UPDATE on the prior card, org-scoped to the caller.
    const retractUpdate = writes.find(
      (w) => w.table === 'cards' && w.op === 'update' && w.eq.card_id === 'card_prior',
    );
    expect(retractUpdate).toBeDefined();
    expect(retractUpdate?.eq.org_id).toBe(ORG);
    expect(retractUpdate?.row?.retracted_reason).toBe('verifier-downgraded');
    expect(persistCalls.some((c) => c.type === 'cardRetracted')).toBe(true);
  });

  it('does NOT retract a pinned prior card', async () => {
    const { db, writes } = recordingDb({ pinned: true });
    const live = new Map<string, string>([['doc_a', 'card_prior']]);
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: live, logger: noopLogger });

    await sink.emitCard(makeCard({ docId: 'doc_a' }));

    expect(writes.some((w) => w.table === 'cards' && w.op === 'update')).toBe(false);
    expect(persistCalls.some((c) => c.type === 'cardRetracted')).toBe(false);
  });
});

describe('synthesis — flash-fix (the sink only persists once the core grounds)', () => {
  it('synthesisStart inserts a running row + broadcasts start; synthesisDone updates to done + broadcasts + closes the loop', async () => {
    const { db, writes } = recordingDb();
    const grounded: string[] = [];
    const sink = createSupabaseSink({
      db,
      meetingId: MEETING,
      orgId: ORG,
      liveCardByDocId: new Map(),
      logger: noopLogger,
      onGroundedAnswer: (t) => grounded.push(t),
    });

    sink.synthesisStart({ synthesisId: 'synth_1', sourceCardIds: ['card_1'], traceId: 'trace_1', utteranceId: 'utt_1' });
    const done: SynthesisDoneInfo = {
      synthesisId: 'synth_1',
      text: 'The answer.',
      citations: [{ rank: 1, cardId: 'card_1', position: 0 }],
      stopReason: 'end_turn',
      latencyMs: 42,
      utteranceId: 'utt_1',
    };
    sink.synthesisDone(done);
    await vi.waitFor(() => expect(grounded).toHaveLength(1));

    const insert = writes.find((w) => w.table === 'syntheses' && w.op === 'insert');
    expect(insert?.row?.org_id).toBe(ORG);
    expect(insert?.row?.status).toBe('running');
    const update = writes.find((w) => w.table === 'syntheses' && w.op === 'update');
    expect(update?.eq.org_id).toBe(ORG);
    expect(update?.row?.status).toBe('done');
    // body is encrypted at rest, never the plaintext.
    expect(update?.row?.accumulated_text_enc).toBe('\\xENC(The answer.)');
    expect(update?.row).not.toHaveProperty('accumulated_text');
    // broadcast order: start then done (delta is separate).
    const types = persistCalls.map((c) => c.type);
    expect(types).toContain('synthesisStart');
    expect(types).toContain('synthesisDone');
    // closed the loop with the grounded body.
    expect(grounded).toEqual(['The answer.']);
  });

  it('synthesisRefusal inserts a retracted row + broadcasts retraction + records the miss', async () => {
    const { db, writes } = recordingDb();
    const misses: MissRecord[] = [];
    const requested: number[] = [];
    const sink = createSupabaseSink({
      db,
      meetingId: MEETING,
      orgId: ORG,
      liveCardByDocId: new Map(),
      logger: noopLogger,
      onMiss: (m) => misses.push(m),
      onSynthesisRequested: () => requested.push(1),
    });

    const refusal: SynthesisRefusalInfo = {
      synthesisId: 'synth_x',
      reason: 'ungrounded',
      latencyMs: 30,
      utteranceId: 'utt_2',
      traceId: 'trace_x',
    };
    sink.synthesisRefusal(refusal);
    // The core records the miss separately (here we assert the sink forwards it).
    sink.recordMiss({
      verbatimQuestion: 'q?',
      utteranceId: 'utt_2',
      meetingId: MEETING,
      orgId: ORG,
      reason: 'ungrounded',
    });
    await vi.waitFor(() =>
      expect(writes.some((w) => w.table === 'syntheses' && w.op === 'insert')).toBe(true),
    );

    const insert = writes.find((w) => w.table === 'syntheses' && w.op === 'insert');
    expect(insert?.row?.org_id).toBe(ORG);
    expect(insert?.row?.status).toBe('retracted');
    expect(insert?.row?.retracted_reason).toBe('ungrounded');
    // trace_id is NOT NULL — refusals skip synthesisStart, so it must be set here.
    expect(insert?.row?.trace_id).toBe('trace_x');
    expect(persistCalls.some((c) => c.type === 'synthesisRetracted')).toBe(true);
    expect(misses).toHaveLength(1);
    expect(misses[0]?.reason).toBe('ungrounded');
    // onSynthesisRequested fired (demand signal) on the refusal terminal.
    expect(requested).toHaveLength(1);
  });

  it('synthesisRetract UPDATES the existing running row to retracted + broadcasts retraction', async () => {
    const { db, writes } = recordingDb();
    const misses: MissRecord[] = [];
    const sink = createSupabaseSink({
      db,
      meetingId: MEETING,
      orgId: ORG,
      liveCardByDocId: new Map(),
      logger: noopLogger,
      onMiss: (m) => misses.push(m),
    });

    // The answer streamed first (running row inserted), then failed grounding.
    sink.synthesisStart({ synthesisId: 'synth_s', sourceCardIds: ['card_1'], traceId: 'trace_s', utteranceId: 'utt_3' });
    const retract: SynthesisRetractInfo = {
      synthesisId: 'synth_s',
      reason: 'ungrounded',
      latencyMs: 55,
      utteranceId: 'utt_3',
      traceId: 'trace_s',
    };
    sink.synthesisRetract(retract);
    sink.recordMiss({
      verbatimQuestion: 'q?',
      utteranceId: 'utt_3',
      meetingId: MEETING,
      orgId: ORG,
      reason: 'ungrounded',
    });
    await vi.waitFor(() =>
      expect(persistCalls.some((c) => c.type === 'synthesisRetracted')).toBe(true),
    );

    // The retract is an UPDATE to `retracted` (NOT an insert of a new row).
    const update = writes.find((w) => w.table === 'syntheses' && w.op === 'update');
    expect(update?.row?.status).toBe('retracted');
    expect(update?.row?.retracted_reason).toBe('ungrounded');
    expect(update?.eq.synthesis_id).toBe('synth_s');
    expect(update?.eq.org_id).toBe(ORG); // org-scoped
    // Exactly one syntheses INSERT happened — the running row from start; the
    // retract did NOT insert a second row (contrast synthesisRefusal).
    const inserts = writes.filter((w) => w.table === 'syntheses' && w.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.row?.status).toBe('running');
    expect(misses).toHaveLength(1);
    expect(misses[0]?.reason).toBe('ungrounded');
  });

  it('resolves additionalSourceRanks against the started source set, in rank order (row + broadcast)', async () => {
    const { db, writes } = recordingDb();
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: new Map(), logger: noopLogger });

    sink.synthesisStart({
      synthesisId: 'synth_a',
      sourceCardIds: ['card_1', 'card_2', 'card_3'],
      traceId: 'trace_a',
      utteranceId: 'utt_a',
    });
    sink.synthesisDone({
      synthesisId: 'synth_a',
      text: 'The answer.',
      citations: [{ rank: 1, cardId: 'card_1', position: 0 }],
      additionalSourceRanks: [2, 3],
      stopReason: 'end_turn',
      latencyMs: 10,
      utteranceId: 'utt_a',
    });
    await vi.waitFor(() => expect(persistCalls.some((c) => c.type === 'synthesisDone')).toBe(true));

    const expected = [
      { cardId: 'card_2', rank: 2 },
      { cardId: 'card_3', rank: 3 },
    ];
    // Persisted on the syntheses row (same idiom as citations).
    const update = writes.find((w) => w.table === 'syntheses' && w.op === 'update');
    expect(update?.row?.additional_sources).toEqual(expected);
    // Broadcast payload carries the SAME resolved entries.
    const doneCall = persistCalls.find((c) => c.type === 'synthesisDone');
    expect((doneCall?.payload.done as { additionalSources?: unknown }).additionalSources).toEqual(expected);
  });

  it('drops a rank beyond the source set at resolution (no broken refs persisted)', async () => {
    const { db, writes } = recordingDb();
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: new Map(), logger: noopLogger });

    sink.synthesisStart({
      synthesisId: 'synth_b',
      sourceCardIds: ['card_1', 'card_2'],
      traceId: 'trace_b',
      utteranceId: 'utt_b',
    });
    sink.synthesisDone({
      synthesisId: 'synth_b',
      text: 'The answer.',
      citations: [{ rank: 1, cardId: 'card_1', position: 0 }],
      additionalSourceRanks: [2, 9], // 9 has no card — must vanish, not crash
      stopReason: 'end_turn',
      latencyMs: 10,
      utteranceId: 'utt_b',
    });
    await vi.waitFor(() => expect(persistCalls.some((c) => c.type === 'synthesisDone')).toBe(true));

    const update = writes.find((w) => w.table === 'syntheses' && w.op === 'update');
    expect(update?.row?.additional_sources).toEqual([{ cardId: 'card_2', rank: 2 }]);
  });

  it('absent ranks → empty column default, NO additionalSources key on the broadcast', async () => {
    const { db, writes } = recordingDb();
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: new Map(), logger: noopLogger });

    sink.synthesisStart({
      synthesisId: 'synth_c',
      sourceCardIds: ['card_1'],
      traceId: 'trace_c',
      utteranceId: 'utt_c',
    });
    sink.synthesisDone({
      synthesisId: 'synth_c',
      text: 'The answer.',
      citations: [{ rank: 1, cardId: 'card_1', position: 0 }],
      stopReason: 'end_turn',
      latencyMs: 10,
      utteranceId: 'utt_c',
    });
    await vi.waitFor(() => expect(persistCalls.some((c) => c.type === 'synthesisDone')).toBe(true));

    const update = writes.find((w) => w.table === 'syntheses' && w.op === 'update');
    expect(update?.row?.additional_sources).toEqual([]);
    const doneCall = persistCalls.find((c) => c.type === 'synthesisDone');
    expect(doneCall?.payload.done).not.toHaveProperty('additionalSources');
  });

  it('onSynthesisRequested fires exactly once per synthesis (on the first terminal)', async () => {
    const { db } = recordingDb();
    const requested: number[] = [];
    const sink = createSupabaseSink({
      db,
      meetingId: MEETING,
      orgId: ORG,
      liveCardByDocId: new Map(),
      logger: noopLogger,
      onSynthesisRequested: () => requested.push(1),
    });
    sink.synthesisStart({ synthesisId: 'synth_1', sourceCardIds: [], traceId: 't', utteranceId: 'u' });
    sink.synthesisDone({
      synthesisId: 'synth_1',
      text: 'x',
      citations: [{ rank: 1, cardId: 'c', position: 0 }],
      stopReason: 'end_turn',
      latencyMs: 1,
      utteranceId: 'u',
    });
    await vi.waitFor(() => expect(requested.length).toBeGreaterThan(0));
    expect(requested).toHaveLength(1);
  });
});

describe('recordMiss / recordSkip', () => {
  it('recordMiss forwards to onMiss', () => {
    const { db } = recordingDb();
    const misses: MissRecord[] = [];
    const sink = createSupabaseSink({
      db,
      meetingId: MEETING,
      orgId: ORG,
      liveCardByDocId: new Map(),
      logger: noopLogger,
      onMiss: (m) => misses.push(m),
    });
    sink.recordMiss({ verbatimQuestion: 'q', utteranceId: 'u', meetingId: MEETING, orgId: ORG, reason: 'no_hits' });
    expect(misses).toHaveLength(1);
  });

  it('recordSkip logs only — no DB write, no broadcast', () => {
    const { db, writes } = recordingDb();
    const sink = createSupabaseSink({ db, meetingId: MEETING, orgId: ORG, liveCardByDocId: new Map(), logger: noopLogger });
    sink.recordSkip({ stage: 'llm-judge', reason: 'not our work', confidence: 0.9 });
    expect(writes).toHaveLength(0);
    expect(persistCalls).toHaveLength(0);
  });
});
