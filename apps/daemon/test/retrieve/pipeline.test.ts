import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { DEFAULT_EMBEDDING_DIM, openCorpusDb } from '../../src/corpus/db.js';
import { migrate } from '../../src/corpus/migrate.js';
import { insertChunk, insertDoc } from '../../src/corpus/query.js';
import { MeetingSession } from '../../src/meeting/session.js';
import { TranscriptStore } from '../../src/transcript/store.js';
import { TranscriptWindow } from '../../src/transcript/window.js';
import { RetrievalPipeline } from '../../src/retrieve/pipeline.js';
import type { CardEvent, RetrievalTrace } from '../../src/retrieve/contract.js';
import type { EmbedRequest, EmbedResult, Embedder } from '../../src/embed/contract.js';

interface Harness {
  db: DatabaseType;
  store: TranscriptStore;
  window: TranscriptWindow;
  session: MeetingSession;
  embedder: Embedder;
  pipeline: RetrievalPipeline;
  dir: string;
  nowRef: { value: number };
}

function unitVectorAt(index: number, magnitude = 1): Float32Array {
  const v = new Float32Array(DEFAULT_EMBEDDING_DIM);
  v[index % DEFAULT_EMBEDDING_DIM] = magnitude;
  return v;
}

function fakeEmbedder(vectorFor: (text: string) => Float32Array): Embedder {
  return {
    dimension: DEFAULT_EMBEDDING_DIM,
    embed(req: EmbedRequest): Promise<EmbedResult> {
      const vectors = req.items.map((item, index) => ({
        index,
        vector: vectorFor(item.text),
        cached: false,
      }));
      return Promise.resolve({
        vectors,
        dimension: DEFAULT_EMBEDDING_DIM,
        inputTokens: req.items.reduce((acc, i) => acc + i.text.length, 0),
        cacheHits: 0,
      });
    },
  };
}

async function setup(
  options: { vectorFor?: (text: string) => Float32Array; debounceMs?: number } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'upwell-pipeline-'));
  const db = await openCorpusDb({ path: join(dir, 'upwell.db') });
  await migrate(db);
  const store = new TranscriptStore(db);
  store.ensureMeeting('m:1', null, 0);
  const session = new MeetingSession('m:1');
  const nowRef = { value: 100_000 };
  const window = new TranscriptWindow({
    meetingId: 'm:1',
    store,
    now: () => nowRef.value,
  });
  const embedder = fakeEmbedder(options.vectorFor ?? (() => unitVectorAt(0)));
  const pipeline = new RetrievalPipeline({
    db,
    embedder,
    session,
    debounceMs: options.debounceMs ?? 0,
    minScore: 0,
    now: () => nowRef.value,
  });
  pipeline.attachWindow(window);
  return { db, store, window, session, embedder, pipeline, dir, nowRef };
}

function teardown(h: Harness): void {
  h.pipeline.detach();
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function indexPR(
  db: DatabaseType,
  opts: { id: string; title: string; text: string; vec: Float32Array },
): void {
  insertDoc(db, {
    id: opts.id,
    source: 'github',
    type: 'pull-request',
    title: opts.title,
    bodySummary: '',
    entities: [],
    authors: ['jamie'],
    updatedAt: Date.now(),
  });
  insertChunk(db, {
    chunkId: `${opts.id}#chunk:0`,
    docId: opts.id,
    domain: 'text',
    text: opts.text,
    embedding: opts.vec,
  });
}

function indexTicket(
  db: DatabaseType,
  opts: { id: string; title: string; text: string; vec: Float32Array },
): void {
  insertDoc(db, {
    id: opts.id,
    source: 'jira',
    type: 'issue',
    title: opts.title,
    bodySummary: '',
    entities: [],
    authors: ['alice'],
    updatedAt: Date.now(),
  });
  insertChunk(db, {
    chunkId: `${opts.id}#chunk:0`,
    docId: opts.id,
    domain: 'text',
    text: opts.text,
    embedding: opts.vec,
  });
}

async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('RetrievalPipeline', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup({ vectorFor: () => unitVectorAt(7) });
  });

  afterEach(() => {
    teardown(h);
  });

  it('AE1: surfaces a PR + a ticket from a question utterance — two card events, distinct docs', async () => {
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:4821',
      title: 'Replace JWT middleware',
      text: 'Replace JWT middleware with auth refactor',
      vec: unitVectorAt(7),
    });
    indexTicket(h.db, {
      id: 'jira:SEC-204',
      title: 'Auth middleware migration',
      text: 'Auth middleware migration plan SEC-204',
      vec: unitVectorAt(7),
    });
    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));

    h.window.push({
      utteranceId: 'u1',
      text: "what's the deal with the auth refactor",
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();

    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.docId))).toEqual(
      new Set(['gh:acme/widget#pr:4821', 'jira:SEC-204']),
    );
    expect(cards.every((c) => c.triggeredBy === 'window')).toBe(true);
  });

  it('dedup: same doc never emitted twice across two consecutive window flushes', async () => {
    indexPR(h.db, {
      id: 'gh:repo#pr:1',
      title: 'Same doc',
      text: 'topic content',
      vec: unitVectorAt(7),
    });
    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));

    h.window.push({
      utteranceId: 'u1',
      text: 'topic',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
    h.window.push({
      utteranceId: 'u2',
      text: 'topic again',
      isFinal: true,
      startMs: 96_000,
      endMs: 97_000,
      revision: 0,
    });
    await flushDebounce();

    expect(cards).toHaveLength(1);
  });

  it('returns no card events when nothing matches', async () => {
    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));
    h.window.push({
      utteranceId: 'u1',
      text: 'totally unrelated',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
    expect(cards).toEqual([]);
  });

  it('emits a trace per evaluation with embed/retrieve/emit timestamps', async () => {
    indexPR(h.db, {
      id: 'gh:x',
      title: 'X',
      text: 'pizza',
      vec: unitVectorAt(7),
    });
    const traces: RetrievalTrace[] = [];
    h.pipeline.on('trace', (t) => traces.push(t));
    h.window.push({
      utteranceId: 'u1',
      text: 'pizza',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
    expect(traces.length).toBe(1);
    const trace = traces[0]!;
    expect(trace.traceId).toMatch(/^t_[0-9a-f]+$/);
    expect(trace.embedStartAt).toBeLessThanOrEqual(trace.embedEndAt);
    expect(trace.retrieveStartAt).toBeLessThanOrEqual(trace.retrieveEndAt);
    expect(trace.cardCount).toBe(1);
  });

  it('embedder failure emits a typed error event and does not crash the pipeline', async () => {
    const errors: Error[] = [];
    const failingEmbedder: Embedder = {
      dimension: DEFAULT_EMBEDDING_DIM,
      embed: () => Promise.reject(new Error('voyage 503')),
    };
    const pipeline = new RetrievalPipeline({
      db: h.db,
      embedder: failingEmbedder,
      session: h.session,
      debounceMs: 0,
      minScore: 0,
      now: () => h.nowRef.value,
    });
    pipeline.attachWindow(h.window);
    pipeline.on('error', (e) => errors.push(e));
    h.window.push({
      utteranceId: 'u1',
      text: 'anything',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('voyage 503');
    pipeline.detach();
  });

  it('trailing-edge debounce: rapid window changes within debounce → at most one evaluation', async () => {
    teardown(h);
    h = await setup({ vectorFor: () => unitVectorAt(7), debounceMs: 100 });
    indexPR(h.db, {
      id: 'gh:burst',
      title: 'Burst',
      text: 'rapid topic content',
      vec: unitVectorAt(7),
    });
    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));

    for (let i = 0; i < 5; i++) {
      h.window.push({
        utteranceId: `u${String(i)}`,
        text: 'rapid topic',
        isFinal: false,
        startMs: 95_000 + i,
        endMs: 95_500 + i,
        revision: i,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cards.length).toBe(1);
  });
});

describe('MeetingSession', () => {
  it('tracks surfaced doc ids and pinned card ids', () => {
    const session = new MeetingSession('m:1');
    const card: CardEvent = {
      cardId: 'c1',
      docId: 'd1',
      source: 'github',
      type: 'issue',
      title: 't',
      snippet: 's',
      score: 0.5,
      rank: 1,
      metadata: {},
      surfacedAt: 0,
      triggeredBy: 'window',
      traceId: 'trace1',
    };
    expect(session.hasSurfaced('d1')).toBe(false);
    session.recordSurfaced(card);
    expect(session.hasSurfaced('d1')).toBe(true);
    expect(session.surfacedCount()).toBe(1);
    expect(session.pin('c1')).toBe(true);
    expect(session.isPinned('c1')).toBe(true);
    expect(session.pinnedCards()).toHaveLength(1);
    expect(session.unpin('c1')).toBe(true);
    expect(session.isPinned('c1')).toBe(false);
  });

  it('pin returns false when card is unknown', () => {
    const session = new MeetingSession('m:1');
    expect(session.pin('unknown')).toBe(false);
  });

  it('clear() removes all session state', () => {
    const session = new MeetingSession('m:1');
    const card: CardEvent = {
      cardId: 'c1',
      docId: 'd1',
      source: 'github',
      type: 'issue',
      title: 't',
      snippet: 's',
      score: 0.5,
      rank: 1,
      metadata: {},
      surfacedAt: 0,
      triggeredBy: 'window',
      traceId: 'trace1',
    };
    session.recordSurfaced(card);
    session.pin('c1');
    session.clear();
    expect(session.surfacedCount()).toBe(0);
    expect(session.isPinned('c1')).toBe(false);
  });
});

// Surface unused import warnings won't fire here — vi is imported for future fake-timer use.
void vi;

// =====================================================================
// U4 — synthesis integration tests
// =====================================================================

import type {
  Synthesizer,
  SynthesisChunk,
  SynthesisInput,
} from '../../src/synthesize/contract.js';
import {
  SynthesisProviderError,
  SynthesisRateLimitError,
} from '../../src/synthesize/contract.js';
import type {
  SynthesisDelta,
  SynthesisDone,
  SynthesisError,
  SynthesisRetracted,
  SynthesisStart,
} from '../../src/retrieve/contract.js';
import { REFUSAL_SENTINEL } from '../../src/synthesize/prompt.js';

interface SynthesisEvents {
  start: SynthesisStart[];
  delta: SynthesisDelta[];
  done: SynthesisDone[];
  error: SynthesisError[];
  retracted: SynthesisRetracted[];
}

function recordSynthesisEvents(pipeline: RetrievalPipeline): SynthesisEvents {
  const events: SynthesisEvents = {
    start: [],
    delta: [],
    done: [],
    error: [],
    retracted: [],
  };
  pipeline.on('synthesisStart', (e) => events.start.push(e));
  pipeline.on('synthesisDelta', (e) => events.delta.push(e));
  pipeline.on('synthesisDone', (e) => events.done.push(e));
  pipeline.on('synthesisError', (e) => events.error.push(e));
  pipeline.on('synthesisRetracted', (e) => events.retracted.push(e));
  return events;
}

function fakeSynthesizer(
  generate: (input: SynthesisInput, signal?: AbortSignal) => AsyncIterable<SynthesisChunk>,
): Synthesizer {
  return {
    synthesize: (input, signal) => generate(input, signal),
  };
}

async function* yieldChunks(chunks: SynthesisChunk[]): AsyncIterable<SynthesisChunk> {
  for (const c of chunks) yield c;
}

function makeChunks(
  synthesisId: string,
  textDeltas: string[],
  stopReason = 'end_turn',
): SynthesisChunk[] {
  return [
    {
      type: 'start',
      synthesisId,
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    ...textDeltas.map((d) => ({ type: 'textDelta' as const, synthesisId, delta: d })),
    {
      type: 'done',
      synthesisId,
      stopReason,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
  ];
}

async function setupWithSynthesizer(opts: {
  synthesizer?: Synthesizer;
  consentCheck?: () => boolean;
  minSynthesisScore?: number;
}): Promise<Harness & { events: SynthesisEvents }> {
  const dir = mkdtempSync(join(tmpdir(), 'upwell-pipeline-syn-'));
  const db = await openCorpusDb({ path: join(dir, 'upwell.db') });
  await migrate(db);
  const store = new TranscriptStore(db);
  store.ensureMeeting('m:1', null, 0);
  const session = new MeetingSession('m:1');
  const nowRef = { value: 100_000 };
  const window = new TranscriptWindow({
    meetingId: 'm:1',
    store,
    now: () => nowRef.value,
  });
  const embedder = fakeEmbedder(() => unitVectorAt(7));
  const pipeline = new RetrievalPipeline({
    db,
    embedder,
    session,
    debounceMs: 0,
    minScore: 0,
    now: () => nowRef.value,
    ...(opts.synthesizer !== undefined && { synthesizer: opts.synthesizer }),
    ...(opts.consentCheck !== undefined && { consentCheck: opts.consentCheck }),
    ...(opts.minSynthesisScore !== undefined && { minSynthesisScore: opts.minSynthesisScore }),
  });
  pipeline.attachWindow(window);
  const events = recordSynthesisEvents(pipeline);
  return { db, store, window, session, embedder, pipeline, dir, nowRef, events };
}

describe('RetrievalPipeline — synthesis gate', () => {
  let h: Awaited<ReturnType<typeof setupWithSynthesizer>>;

  afterEach(() => {
    if (h !== undefined) teardown(h);
  });

  async function speakAndFlush(window: TranscriptWindow): Promise<void> {
    window.push({
      utteranceId: 'u1',
      text: "what's the deal with the auth refactor",
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
  }

  it('does NOT invoke the synthesizer when no synthesizer is configured', async () => {
    h = await setupWithSynthesizer({});
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:4821',
      title: 't',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    await speakAndFlush(h.window);
    expect(h.events.start).toHaveLength(0);
  });

  it('does NOT invoke the synthesizer when consentCheck returns false', async () => {
    const calls: SynthesisInput[] = [];
    const synth = fakeSynthesizer((input) => {
      calls.push(input);
      return yieldChunks(makeChunks('s1', ['ok [1].']));
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => false,
      minSynthesisScore: 0,
    });
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:4821',
      title: 't',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    await speakAndFlush(h.window);
    expect(calls).toHaveLength(0);
    expect(h.events.start).toHaveLength(0);
  });

  it('does NOT invoke the synthesizer when top card score is below minSynthesisScore', async () => {
    const calls: SynthesisInput[] = [];
    const synth = fakeSynthesizer((input) => {
      calls.push(input);
      return yieldChunks(makeChunks('s1', ['ok [1].']));
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0.99, // impossibly high
    });
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:4821',
      title: 't',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    await speakAndFlush(h.window);
    expect(calls).toHaveLength(0);
    expect(h.events.start).toHaveLength(0);
  });

  it('does NOT invoke the synthesizer when no new cards were emitted (all already surfaced)', async () => {
    const calls: SynthesisInput[] = [];
    const synth = fakeSynthesizer((input) => {
      calls.push(input);
      return yieldChunks(makeChunks('s1', ['ok [1].']));
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:4821',
      title: 't',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    // First flush surfaces the card → fires synthesis.
    await speakAndFlush(h.window);
    expect(calls).toHaveLength(1);
    expect(h.events.start).toHaveLength(1);

    // Second flush on same window: no new card (already surfaced via session) →
    // gate skips synthesis.
    h.window.push({
      utteranceId: 'u2',
      text: 'auth refactor still',
      isFinal: true,
      startMs: 97_000,
      endMs: 98_000,
      revision: 0,
    });
    await flushDebounce();
    expect(calls).toHaveLength(1);
    expect(h.events.start).toHaveLength(1);
  });

  it('invokes the synthesizer when all gate conditions are met', async () => {
    const calls: SynthesisInput[] = [];
    const synth = fakeSynthesizer((input) => {
      calls.push(input);
      return yieldChunks(makeChunks('s1', ['The auth refactor is in progress [1].']));
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:4821',
      title: 'PR title',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    await speakAndFlush(h.window);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sources).toHaveLength(1);
    expect(calls[0]!.sources[0]!.rank).toBe(1);
    expect(calls[0]!.utterance).toContain('auth refactor');
    expect(h.events.start).toHaveLength(1);
    expect(h.events.delta).toHaveLength(1);
    expect(h.events.done).toHaveLength(1);
    expect(h.events.done[0]!.citations).toEqual([1]);
  });
});

describe('RetrievalPipeline — synthesis streaming + outcomes', () => {
  let h: Awaited<ReturnType<typeof setupWithSynthesizer>>;

  afterEach(() => {
    if (h !== undefined) teardown(h);
  });

  it('streams deltas in order and drops invalid citations from synthesisDone', async () => {
    const synth = fakeSynthesizer(() =>
      yieldChunks(makeChunks('s1', ['First [1] ', 'second [5] ', 'third [2].'])),
    );
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:1',
      title: 'A',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    indexTicket(h.db, {
      id: 'jira:SEC-204',
      title: 'B',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    h.window.push({
      utteranceId: 'u1',
      text: 'auth refactor',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();

    expect(h.events.delta.map((d) => d.delta)).toEqual([
      'First [1] ',
      'second [5] ',
      'third [2].',
    ]);
    // Two sources → citations [1, 2] are valid; [5] dropped.
    expect(h.events.done).toHaveLength(1);
    expect(h.events.done[0]!.citations).toEqual([1, 2]);
    expect(h.events.error).toHaveLength(0);
  });

  it('emits synthesisError {code: refused} when the model outputs the refusal sentinel', async () => {
    const synth = fakeSynthesizer(() =>
      yieldChunks(makeChunks('s1', [REFUSAL_SENTINEL])),
    );
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, {
      id: 'gh:acme/widget#pr:1',
      title: 'A',
      text: 'auth refactor',
      vec: unitVectorAt(7),
    });
    h.window.push({
      utteranceId: 'u1',
      text: 'auth refactor',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();

    expect(h.events.start).toHaveLength(1);
    expect(h.events.delta).toHaveLength(1);
    expect(h.events.delta[0]!.delta).toBe(REFUSAL_SENTINEL);
    expect(h.events.done).toHaveLength(0);
    expect(h.events.error).toHaveLength(1);
    expect(h.events.error[0]!.code).toBe('refused');
  });

  it('emits synthesisError with the provider error kind when synthesizer throws', async () => {
    const synth = fakeSynthesizer(async function* () {
      yield {
        type: 'start' as const,
        synthesisId: 's1',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      throw new SynthesisProviderError('overloaded', 'Anthropic 529');
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, { id: 'gh:a#pr:1', title: 'A', text: 'auth', vec: unitVectorAt(7) });
    h.window.push({
      utteranceId: 'u1',
      text: 'auth',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();

    expect(h.events.start).toHaveLength(1);
    expect(h.events.error).toHaveLength(1);
    expect(h.events.error[0]!.code).toBe('overloaded');
  });

  it('maps SynthesisRateLimitError to synthesisError {code: rate-limited, retryAfterMs}', async () => {
    const synth = fakeSynthesizer(async function* () {
      yield {
        type: 'start' as const,
        synthesisId: 's1',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      throw new SynthesisRateLimitError('429', 5000);
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, { id: 'gh:a#pr:1', title: 'A', text: 'auth', vec: unitVectorAt(7) });
    h.window.push({
      utteranceId: 'u1',
      text: 'auth',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();

    expect(h.events.error).toHaveLength(1);
    expect(h.events.error[0]!.code).toBe('rate-limited');
    expect(h.events.error[0]!.retryAfterMs).toBe(5000);
  });

  it('raw cards ship BEFORE the synthesizer is consumed (fire-and-forget)', async () => {
    let synthesizerStarted = false;
    const synth = fakeSynthesizer(async function* () {
      synthesizerStarted = true;
      yield {
        type: 'start' as const,
        synthesisId: 's1',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      // Stay open forever — the test asserts cards fired without awaiting synthesis.
      await new Promise<void>(() => undefined);
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, { id: 'gh:a#pr:1', title: 'A', text: 'auth', vec: unitVectorAt(7) });

    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));

    h.window.push({
      utteranceId: 'u1',
      text: 'auth',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    // Just enough time for the debounced flush to run; if #evaluate had
    // awaited synthesis, the card emit would block too.
    await new Promise((r) => setTimeout(r, 50));
    expect(cards).toHaveLength(1);
    expect(synthesizerStarted).toBe(true);
    // Synthesis never finished — but raw card already shipped.
    expect(h.events.done).toHaveLength(0);
    expect(h.events.error).toHaveLength(0);
  });
});

describe('RetrievalPipeline — synthesis abort + retract cascade', () => {
  let h: Awaited<ReturnType<typeof setupWithSynthesizer>>;

  afterEach(() => {
    if (h !== undefined) teardown(h);
  });

  it('aborts the in-flight synthesis when a new schedule fires', async () => {
    let inFlightAborted = false;
    const synth = fakeSynthesizer(async function* (_input, signal) {
      yield {
        type: 'start' as const,
        synthesisId: 's1',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      // Wait on the signal — if aborted, throw AbortError; otherwise hang.
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          inFlightAborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal?.aborted === true) onAbort();
        else signal?.addEventListener('abort', onAbort);
        // never resolves on its own
      });
      // Unreachable
      yield {
        type: 'done' as const,
        synthesisId: 's1',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    });
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, { id: 'gh:a#pr:1', title: 'A', text: 'auth', vec: unitVectorAt(7) });

    h.window.push({
      utteranceId: 'u1',
      text: 'auth',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
    expect(h.events.start).toHaveLength(1);

    // New schedule arrives — fires before the first synthesis completes.
    h.window.push({
      utteranceId: 'u2',
      text: 'something else entirely',
      isFinal: true,
      startMs: 96_500,
      endMs: 97_000,
      revision: 0,
    });
    await flushDebounce();
    // Give the aborted-promise rejection a chance to settle.
    await new Promise((r) => setTimeout(r, 30));

    expect(inFlightAborted).toBe(true);
    // First synthesis: NO done, NO error (abort is silent).
    expect(h.events.done.filter((d) => d.synthesisId === h.events.start[0]!.synthesisId)).toHaveLength(0);
    expect(h.events.error.filter((e) => e.synthesisId === h.events.start[0]!.synthesisId)).toHaveLength(0);
  });

  it('cascades synthesisRetracted when a cited card is retracted', async () => {
    const synth = fakeSynthesizer(() =>
      yieldChunks(makeChunks('s1', ['ok [1].'])),
    );
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, { id: 'gh:a#pr:1', title: 'A', text: 'auth', vec: unitVectorAt(7) });
    indexTicket(h.db, { id: 'jira:B', title: 'B', text: 'auth', vec: unitVectorAt(7) });

    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));

    h.window.push({
      utteranceId: 'u1',
      text: 'auth',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();
    expect(h.events.done).toHaveLength(1);

    // Retract the cited card (rank 1).
    const citedCardId = cards[0]!.cardId;
    h.pipeline.retractCard({ cardId: citedCardId, reason: 'verifier-downgraded' });
    expect(h.events.retracted).toHaveLength(1);
    expect(h.events.retracted[0]!.synthesisId.startsWith('syn_')).toBe(true);
    expect(h.events.retracted[0]!.reason).toBe('source-retracted');
  });

  it('does NOT cascade when a non-cited card is retracted', async () => {
    // Synthesizer cites only [1]; cards[1] is uncited.
    const synth = fakeSynthesizer(() =>
      yieldChunks(makeChunks('s1', ['ok [1].'])),
    );
    h = await setupWithSynthesizer({
      synthesizer: synth,
      consentCheck: () => true,
      minSynthesisScore: 0,
    });
    indexPR(h.db, { id: 'gh:a#pr:1', title: 'A', text: 'auth', vec: unitVectorAt(7) });
    indexTicket(h.db, { id: 'jira:B', title: 'B', text: 'auth', vec: unitVectorAt(7) });

    const cards: CardEvent[] = [];
    h.pipeline.on('card', (c) => cards.push(c));

    h.window.push({
      utteranceId: 'u1',
      text: 'auth',
      isFinal: true,
      startMs: 95_000,
      endMs: 96_000,
      revision: 0,
    });
    await flushDebounce();

    // Retract rank-2 (uncited) — NO retract event should fire.
    const uncitedCardId = cards[1]!.cardId;
    h.pipeline.retractCard({ cardId: uncitedCardId, reason: 'manual-dismiss' });
    expect(h.events.retracted).toHaveLength(0);
  });
});
