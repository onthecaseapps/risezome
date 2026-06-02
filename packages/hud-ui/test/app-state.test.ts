import { describe, expect, it } from 'vitest';
import { appStateReducer, initialAppState } from '../src/state/app-state.js';
import type {
  CardEvent,
  SynthesisDeltaEvent,
  SynthesisDoneEvent,
  SynthesisStartEvent,
  TranscriptUtterance,
} from '../src/types.js';

function mkUtterance(over: Partial<TranscriptUtterance> = {}): TranscriptUtterance {
  return {
    utteranceId: 'p1::1000',
    text: 'hello there',
    speaker: 'Alice',
    isFinal: false,
    startMs: 1000,
    revision: 0,
    ...over,
  };
}

function mkCard(over: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'c1',
    docId: 'd1',
    source: 'github',
    type: 'issue',
    title: 'Issue title',
    snippet: 'snippet body',
    score: 0.9,
    rank: 1,
    metadata: {},
    surfacedAt: 1700000000_000,
    triggeredBy: 'window',
    traceId: 't1',
    ...over,
  };
}

describe('appStateReducer', () => {
  it('starts with empty state and disconnected status', () => {
    expect(initialAppState.status).toBe('disconnected');
    expect(initialAppState.meeting).toBe('idle');
    expect(initialAppState.cards.size).toBe(0);
    expect(initialAppState.syntheses.size).toBe(0);
  });

  it('wsStatus action updates the connection status', () => {
    const next = appStateReducer(initialAppState, { type: 'wsStatus', status: 'open' });
    expect(next.status).toBe('open');
    expect(next).not.toBe(initialAppState);
  });

  it('card action appends a new card by cardId', () => {
    const next = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    expect(next.cards.size).toBe(1);
    expect(next.cards.get('c1')?.card.title).toBe('Issue title');
    expect(next.cards.get('c1')?.pinned).toBe(false);
  });

  it('card action replaces an existing card with the same cardId', () => {
    const s1 = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    const s2 = appStateReducer(s1, {
      type: 'card',
      card: mkCard({ title: 'Updated title' }),
    });
    expect(s2.cards.size).toBe(1);
    expect(s2.cards.get('c1')?.card.title).toBe('Updated title');
  });

  it('cardUpdated patches score/triggeredBy/metadata on the existing card', () => {
    const s1 = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    const s2 = appStateReducer(s1, {
      type: 'cardUpdated',
      update: { cardId: 'c1', score: 0.5, triggeredBy: 'question-provisional' },
    });
    expect(s2.cards.get('c1')?.card.score).toBe(0.5);
    expect(s2.cards.get('c1')?.card.triggeredBy).toBe('question-provisional');
    expect(s2.cards.get('c1')?.card.title).toBe('Issue title');
  });

  it('cardUpdated is a no-op when the cardId is unknown', () => {
    const next = appStateReducer(initialAppState, {
      type: 'cardUpdated',
      update: { cardId: 'unknown', score: 0.1 },
    });
    expect(next).toBe(initialAppState);
  });

  it('cardRetracted removes the card', () => {
    const s1 = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    const s2 = appStateReducer(s1, {
      type: 'cardRetracted',
      retracted: { cardId: 'c1', reason: 'verifier-downgraded' },
    });
    expect(s2.cards.size).toBe(0);
  });

  it('cardRetracted cascades to retract any synthesis citing it', () => {
    let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1'],
      traceId: 'tr1',
    };
    s = appStateReducer(s, { type: 'synthesisStart', start });
    expect(s.syntheses.size).toBe(1);
    s = appStateReducer(s, {
      type: 'cardRetracted',
      retracted: { cardId: 'c1', reason: 'verifier-downgraded' },
    });
    expect(s.syntheses.size).toBe(0);
  });

  it('cardRetracted does NOT cascade to a COMPLETED synthesis (survives source rotation)', () => {
    // Regression: window cards rotate out constantly; a finished AI summary
    // must stay on screen when a cited card is retracted. On the live page the
    // reconnect-replay fast-forwards every historical cardRetracted in one
    // pass — without this, the whole seeded feed flashes then collapses to the
    // single newest summary.
    let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    s = appStateReducer(s, {
      type: 'synthesisStart',
      start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
    });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'Answer.' } });
    s = appStateReducer(s, {
      type: 'synthesisDone',
      done: {
        synthesisId: 'syn1',
        stopReason: 'end_turn',
        citations: [{ rank: 1, cardId: 'c1', position: 0 }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ttftMs: 0,
        latencyMs: 0,
      },
    });
    s = appStateReducer(s, {
      type: 'cardRetracted',
      retracted: { cardId: 'c1', reason: 'verifier-downgraded' },
    });
    // Completed synthesis survives AND keeps its cited card so it can still
    // render its SOURCES list + "grounded in N" count (no "0 sources").
    expect(s.syntheses.has('syn1')).toBe(true);
    expect(s.syntheses.get('syn1')?.accumulatedText).toBe('Answer.');
    expect(s.cards.has('c1')).toBe(true);
  });

  it('cardRetracted drops the card once no surviving synthesis cites it', () => {
    // A streaming synthesis citing the card is cascaded away → nothing cites
    // the card anymore → the card is removed (no leak).
    let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
    s = appStateReducer(s, {
      type: 'synthesisStart',
      start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
    });
    s = appStateReducer(s, {
      type: 'cardRetracted',
      retracted: { cardId: 'c1', reason: 'verifier-downgraded' },
    });
    expect(s.syntheses.has('syn1')).toBe(false);
    expect(s.cards.has('c1')).toBe(false);
  });

  it('meetingStarted/meetingEnded flips the meeting mode', () => {
    const s1 = appStateReducer(initialAppState, { type: 'meetingStarted' });
    expect(s1.meeting).toBe('live');
    const s2 = appStateReducer(s1, { type: 'meetingEnded' });
    expect(s2.meeting).toBe('idle');
  });

  it('meetingStatus maps idle/capturing/processing to idle/live', () => {
    const idle = appStateReducer(initialAppState, { type: 'meetingStatus', mode: 'idle' });
    expect(idle.meeting).toBe('idle');
    const live = appStateReducer(initialAppState, { type: 'meetingStatus', mode: 'live' });
    expect(live.meeting).toBe('live');
  });

  it('synthesisStart adds a streaming synthesis with empty accumulated text', () => {
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1', 'c2'],
      traceId: 'tr1',
    };
    const next = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    expect(next.syntheses.size).toBe(1);
    const syn = next.syntheses.get('syn1');
    expect(syn?.streaming).toBe(true);
    expect(syn?.accumulatedText).toBe('');
    expect(syn?.sourceCardIds).toEqual(['c1', 'c2']);
  });

  it('synthesisDelta appends text to the active synthesis', () => {
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1'],
      traceId: 'tr1',
    };
    let s = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    const delta1: SynthesisDeltaEvent = { synthesisId: 'syn1', delta: 'Hello ' };
    const delta2: SynthesisDeltaEvent = { synthesisId: 'syn1', delta: 'world.' };
    s = appStateReducer(s, { type: 'synthesisDelta', delta: delta1 });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: delta2 });
    expect(s.syntheses.get('syn1')?.accumulatedText).toBe('Hello world.');
  });

  it('synthesisDelta is a no-op when the synthesisId is unknown', () => {
    const next = appStateReducer(initialAppState, {
      type: 'synthesisDelta',
      delta: { synthesisId: 'ghost', delta: 'x' },
    });
    expect(next).toBe(initialAppState);
  });

  it('synthesisStart is a no-op when the synthesisId already exists (S6 replay guard)', () => {
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1'],
      traceId: 'tr1',
    };
    let s = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'Hello ' } });
    // Replayed synthesisStart: must NOT reset accumulatedText or streaming.
    const next = appStateReducer(s, { type: 'synthesisStart', start });
    expect(next).toBe(s);
    expect(next.syntheses.get('syn1')?.accumulatedText).toBe('Hello ');
    expect(next.syntheses.get('syn1')?.streaming).toBe(true);
  });

  it('synthesisDone marks streaming false and records citations + sets announce text', () => {
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1'],
      traceId: 'tr1',
    };
    let s = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'Body' } });
    const done: SynthesisDoneEvent = {
      synthesisId: 'syn1',
      stopReason: 'end_turn',
      citations: [{ rank: 1, cardId: 'c1', position: 0, quote: 'verbatim' }],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ttftMs: 200,
      latencyMs: 800,
    };
    s = appStateReducer(s, { type: 'synthesisDone', done });
    const syn = s.syntheses.get('syn1');
    expect(syn?.streaming).toBe(false);
    expect(syn?.citations).toEqual([{ rank: 1, cardId: 'c1', position: 0, quote: 'verbatim' }]);
    expect(s.lastSynthesisAnnounce).toBe('Body');
  });

  it('synthesisDelta is a no-op once a synthesis is done (S6 replay guard — no doubling)', () => {
    // Regression: on the live page the channel's reconnect-replay re-delivers
    // synthesisStart/Delta/Done for a synthesis already hydrated from the DB
    // seed. The replayed delta must NOT re-append the full answer (which made
    // the card render doubled). Deltas only apply while streaming.
    const start: SynthesisStartEvent = { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' };
    let s = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'The full answer.' } });
    s = appStateReducer(s, {
      type: 'synthesisDone',
      done: {
        synthesisId: 'syn1',
        stopReason: 'end_turn',
        citations: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ttftMs: 0,
        latencyMs: 0,
      },
    });
    expect(s.syntheses.get('syn1')?.accumulatedText).toBe('The full answer.');
    // Replayed delta on the completed synthesis — must be dropped, not appended.
    const replayed = appStateReducer(s, {
      type: 'synthesisDelta',
      delta: { synthesisId: 'syn1', delta: 'The full answer.' },
    });
    expect(replayed).toBe(s);
    expect(replayed.syntheses.get('syn1')?.accumulatedText).toBe('The full answer.');
  });

  it('synthesisError removes the synthesis (matches main.ts removeSynthesis)', () => {
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1'],
      traceId: 'tr1',
    };
    let s = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    s = appStateReducer(s, {
      type: 'synthesisError',
      error: { synthesisId: 'syn1', code: 'refused' },
    });
    expect(s.syntheses.has('syn1')).toBe(false);
  });

  it('synthesisRetracted removes the synthesis', () => {
    const start: SynthesisStartEvent = {
      synthesisId: 'syn1',
      sourceCardIds: ['c1'],
      traceId: 'tr1',
    };
    let s = appStateReducer(initialAppState, { type: 'synthesisStart', start });
    s = appStateReducer(s, {
      type: 'synthesisRetracted',
      retracted: { synthesisId: 'syn1', reason: 'source-retracted' },
    });
    expect(s.syntheses.has('syn1')).toBe(false);
  });

  it('integration: start → 3 deltas → done is idempotent in shape', () => {
    let s = appStateReducer(initialAppState, {
      type: 'synthesisStart',
      start: { synthesisId: 'syn1', sourceCardIds: [], traceId: 't' },
    });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'A' } });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'B' } });
    s = appStateReducer(s, { type: 'synthesisDelta', delta: { synthesisId: 'syn1', delta: 'C' } });
    s = appStateReducer(s, {
      type: 'synthesisDone',
      done: {
        synthesisId: 'syn1',
        stopReason: 'end_turn',
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ttftMs: 0,
        latencyMs: 0,
      },
    });
    expect(s.syntheses.get('syn1')?.accumulatedText).toBe('ABC');
    expect(s.syntheses.get('syn1')?.streaming).toBe(false);
  });

  describe('synthesisPinned (U5)', () => {
    it('flips pinned + pinnedAt on the matching record', () => {
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
      });
      expect(s.syntheses.get('syn1')?.pinned).toBe(false);
      expect(s.syntheses.get('syn1')?.pinnedAt).toBeNull();

      const at = '2026-05-31T12:00:00.000Z';
      s = appStateReducer(s, { type: 'synthesisPinned', synthesisId: 'syn1', pinned: true, pinnedAt: at });
      expect(s.syntheses.get('syn1')?.pinned).toBe(true);
      expect(s.syntheses.get('syn1')?.pinnedAt).toBe(at);
    });

    it('unpinning clears pinnedAt', () => {
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
      });
      s = appStateReducer(s, { type: 'synthesisPinned', synthesisId: 'syn1', pinned: true, pinnedAt: '2026-05-31T12:00:00.000Z' });
      s = appStateReducer(s, { type: 'synthesisPinned', synthesisId: 'syn1', pinned: false, pinnedAt: null });
      expect(s.syntheses.get('syn1')?.pinned).toBe(false);
      expect(s.syntheses.get('syn1')?.pinnedAt).toBeNull();
    });

    it('is a no-op when the synthesisId is unknown', () => {
      const next = appStateReducer(initialAppState, {
        type: 'synthesisPinned',
        synthesisId: 'ghost',
        pinned: true,
        pinnedAt: '2026-05-31T12:00:00.000Z',
      });
      expect(next).toBe(initialAppState);
    });

    it('is idempotent — same state dispatch twice produces identity-equal state', () => {
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
      });
      s = appStateReducer(s, { type: 'synthesisPinned', synthesisId: 'syn1', pinned: true, pinnedAt: 'X' });
      const next = appStateReducer(s, { type: 'synthesisPinned', synthesisId: 'syn1', pinned: true, pinnedAt: 'X' });
      expect(next).toBe(s);
    });
  });

  describe('synthesisFailureStreak (U8 / S3 — paused-pill signal)', () => {
    it('initial state has streak === 0', () => {
      expect(initialAppState.synthesisFailureStreak).toBe(0);
    });

    it('synthesisError increments the streak (record removed too)', () => {
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
      });
      s = appStateReducer(s, {
        type: 'synthesisError',
        error: { synthesisId: 'syn1', code: 'rate-limited' },
      });
      expect(s.synthesisFailureStreak).toBe(1);
      expect(s.syntheses.has('syn1')).toBe(false);
    });

    it('synthesisRetracted also increments the streak (refusals count)', () => {
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'syn1', sourceCardIds: ['c1'], traceId: 'tr1' },
      });
      s = appStateReducer(s, {
        type: 'synthesisRetracted',
        retracted: { synthesisId: 'syn1', reason: 'source-retracted' },
      });
      expect(s.synthesisFailureStreak).toBe(1);
    });

    it('three consecutive failures → streak reaches the paused threshold', async () => {
      const { SYNTHESIS_PAUSED_THRESHOLD } = await import('../src/state/app-state.js');
      let s = initialAppState;
      for (let i = 0; i < SYNTHESIS_PAUSED_THRESHOLD; i++) {
        s = appStateReducer(s, { type: 'card', card: mkCard({ cardId: `c${String(i)}` }) });
        s = appStateReducer(s, {
          type: 'synthesisStart',
          start: { synthesisId: `syn${String(i)}`, sourceCardIds: [`c${String(i)}`], traceId: 't' },
        });
        s = appStateReducer(s, {
          type: 'synthesisError',
          error: { synthesisId: `syn${String(i)}`, code: 'rate-limited' },
        });
      }
      expect(s.synthesisFailureStreak).toBe(SYNTHESIS_PAUSED_THRESHOLD);
    });

    it('synthesisDone resets the streak to 0 (single success clears the pill)', () => {
      // Seed: streak === 2 via two errors.
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard({ cardId: 'a' }) });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'sa', sourceCardIds: ['a'], traceId: 't' },
      });
      s = appStateReducer(s, {
        type: 'synthesisError',
        error: { synthesisId: 'sa', code: 'rate-limited' },
      });
      s = appStateReducer(s, { type: 'card', card: mkCard({ cardId: 'b' }) });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'sb', sourceCardIds: ['b'], traceId: 't' },
      });
      s = appStateReducer(s, {
        type: 'synthesisError',
        error: { synthesisId: 'sb', code: 'rate-limited' },
      });
      expect(s.synthesisFailureStreak).toBe(2);

      // A successful done clears the streak.
      s = appStateReducer(s, { type: 'card', card: mkCard({ cardId: 'c' }) });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'sc', sourceCardIds: ['c'], traceId: 't' },
      });
      s = appStateReducer(s, {
        type: 'synthesisDone',
        done: {
          synthesisId: 'sc',
          stopReason: 'end_turn',
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          ttftMs: 0,
          latencyMs: 0,
        },
      });
      expect(s.synthesisFailureStreak).toBe(0);
    });

    it('mixed sequence: err err done err err err → streak ends at 3', () => {
      let s = initialAppState;
      // 2 errors.
      for (const id of ['s1', 's2']) {
        s = appStateReducer(s, { type: 'card', card: mkCard({ cardId: `c-${id}` }) });
        s = appStateReducer(s, {
          type: 'synthesisStart',
          start: { synthesisId: id, sourceCardIds: [`c-${id}`], traceId: 't' },
        });
        s = appStateReducer(s, {
          type: 'synthesisError',
          error: { synthesisId: id, code: 'rate-limited' },
        });
      }
      // 1 done (resets).
      s = appStateReducer(s, { type: 'card', card: mkCard({ cardId: 'c-ok' }) });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'ok', sourceCardIds: ['c-ok'], traceId: 't' },
      });
      s = appStateReducer(s, {
        type: 'synthesisDone',
        done: {
          synthesisId: 'ok',
          stopReason: 'end_turn',
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          ttftMs: 0,
          latencyMs: 0,
        },
      });
      expect(s.synthesisFailureStreak).toBe(0);
      // 3 more errors.
      for (const id of ['s3', 's4', 's5']) {
        s = appStateReducer(s, { type: 'card', card: mkCard({ cardId: `c-${id}` }) });
        s = appStateReducer(s, {
          type: 'synthesisStart',
          start: { synthesisId: id, sourceCardIds: [`c-${id}`], traceId: 't' },
        });
        s = appStateReducer(s, {
          type: 'synthesisError',
          error: { synthesisId: id, code: 'rate-limited' },
        });
      }
      expect(s.synthesisFailureStreak).toBe(3);
    });
  });

  describe('cardRetracted cascade preservation for pinned syntheses (U5 / S2)', () => {
    it('drops unpinned syntheses citing the retracted card but PRESERVES pinned ones', () => {
      // Seed: card c1, two syntheses, only one is pinned.
      let s = appStateReducer(initialAppState, { type: 'card', card: mkCard() });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'unpinned', sourceCardIds: ['c1'], traceId: 'tA' },
      });
      s = appStateReducer(s, {
        type: 'synthesisStart',
        start: { synthesisId: 'pinned', sourceCardIds: ['c1'], traceId: 'tB' },
      });
      s = appStateReducer(s, {
        type: 'synthesisPinned',
        synthesisId: 'pinned',
        pinned: true,
        pinnedAt: '2026-05-31T12:00:00.000Z',
      });
      expect(s.syntheses.size).toBe(2);

      // Retract the cited card.
      s = appStateReducer(s, {
        type: 'cardRetracted',
        retracted: { cardId: 'c1', reason: 'verifier-downgraded' },
      });

      // Unpinned (streaming) synthesis cascaded away; pinned synthesis SURVIVES
      // and still cites c1 — so the card is RETAINED (not orphaned) and the
      // pinned answer keeps rendering its source rather than dropping to
      // "grounded in 0 sources".
      expect(s.syntheses.has('unpinned')).toBe(false);
      expect(s.syntheses.has('pinned')).toBe(true);
      expect(s.syntheses.get('pinned')?.sourceCardIds).toContain('c1');
      expect(s.cards.has('c1')).toBe(true);
    });
  });
});

describe('appStateReducer — transcript (U3)', () => {
  it('adds a partial utterance to the transcript', () => {
    const s = appStateReducer(initialAppState, {
      type: 'transcriptUtterance',
      utterance: mkUtterance(),
    });
    expect(s.transcript.size).toBe(1);
    const u = s.transcript.get('p1::1000');
    expect(u?.isFinal).toBe(false);
    expect(u?.speaker).toBe('Alice');
  });

  it('a final replaces its partial in place (same utteranceId)', () => {
    let s = appStateReducer(initialAppState, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ text: 'hello', isFinal: false, revision: 0 }),
    });
    s = appStateReducer(s, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ text: 'hello world.', isFinal: true, revision: 1 }),
    });
    expect(s.transcript.size).toBe(1);
    const u = s.transcript.get('p1::1000');
    expect(u?.isFinal).toBe(true);
    expect(u?.text).toBe('hello world.');
  });

  it('a replayed partial does NOT overwrite an already-final utterance (reconnect-idempotent)', () => {
    let s = appStateReducer(initialAppState, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ text: 'final text', isFinal: true, revision: 2 }),
    });
    const next = appStateReducer(s, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ text: 'stale partial', isFinal: false, revision: 1 }),
    });
    expect(next).toBe(s);
    expect(next.transcript.get('p1::1000')?.text).toBe('final text');
  });

  it('a duplicate replay (same finality + revision) is a no-op', () => {
    const s = appStateReducer(initialAppState, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ isFinal: true, revision: 3 }),
    });
    const next = appStateReducer(s, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ isFinal: true, revision: 3 }),
    });
    expect(next).toBe(s);
  });

  it('distinct utteranceIds both appear', () => {
    let s = appStateReducer(initialAppState, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ utteranceId: 'p1::1000', startMs: 1000 }),
    });
    s = appStateReducer(s, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ utteranceId: 'p2::2000', startMs: 2000, speaker: 'Bob' }),
    });
    expect(s.transcript.size).toBe(2);
  });

  it('keeps a null speaker without erroring', () => {
    const s = appStateReducer(initialAppState, {
      type: 'transcriptUtterance',
      utterance: mkUtterance({ speaker: null }),
    });
    expect(s.transcript.get('p1::1000')?.speaker).toBeNull();
  });
});
