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
