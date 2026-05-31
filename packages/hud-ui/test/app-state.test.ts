import { describe, expect, it } from 'vitest';
import { appStateReducer, initialAppState } from '../src/state/app-state.js';
import type {
  CardEvent,
  SynthesisDeltaEvent,
  SynthesisDoneEvent,
  SynthesisStartEvent,
} from '../src/types.js';

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
      citations: [1],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ttftMs: 200,
      latencyMs: 800,
    };
    s = appStateReducer(s, { type: 'synthesisDone', done });
    const syn = s.syntheses.get('syn1');
    expect(syn?.streaming).toBe(false);
    expect(syn?.citations).toEqual([1]);
    expect(s.lastSynthesisAnnounce).toBe('Body');
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
});
