import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VoyageEmbedder, EmbedRequest, EmbedResult } from '@risezome/engine/embed';
import type {
  Synthesizer,
  SynthesisInput,
  SynthesisChunk,
} from '@risezome/engine/synthesize';
import type { RelevanceClassifier, RelevanceResult } from '@risezome/engine/relevance';
import type { MissRecord } from '@risezome/engine/gaps';
import { runPipeline } from '../../src/pipeline/core.js';
import type {
  PipelineDeps,
  PipelineInput,
  PipelineSink,
  PipelineCard,
  EmittedCard,
  PipelineTrace,
  SynthesisStartInfo,
  SynthesisDoneInfo,
  SynthesisRefusalInfo,
  SynthesisRetractInfo,
  SkipInfo,
  HybridSearchFn,
} from '../../src/pipeline/contract.js';
import type { HybridHit } from '../../src/corpus-search.js';

// ── Fakes ───────────────────────────────────────────────────────────────

const ORG = 'org_1';
const noopLogger = { info: () => undefined, warn: () => undefined };

function fakeEmbedder(): VoyageEmbedder {
  const embed = vi.fn(
    async (_req: EmbedRequest): Promise<EmbedResult> => ({
      vectors: [{ index: 0, vector: new Float32Array([0.1, 0.2, 0.3]), cached: false }],
      dimension: 3,
      inputTokens: 1,
      cacheHits: 0,
    }),
  );
  return { dimension: 3, embed } as unknown as VoyageEmbedder;
}

/** A Supabase stub whose `from(...).select(...).in(...).eq(...)` chain resolves
 *  the chunk/doc enrichment rows for a fixed hit. */
function fakeDb(chunkRows: object[], docRows: object[]): SupabaseClient {
  const from = (table: string): unknown => {
    const rows = table === 'doc_chunks' ? chunkRows : docRows;
    const chain = {
      select: () => chain,
      in: () => chain,
      eq: () => Promise.resolve({ data: rows, error: null }),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

/** A synthesizer that yields a fixed body (start → textDelta → done). */
function fakeSynthesizer(body: string): Synthesizer {
  return {
    async *synthesize(_input: SynthesisInput): AsyncIterable<SynthesisChunk> {
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
      yield { type: 'start', synthesisId: 's', model: 'fake', usage };
      yield { type: 'textDelta', synthesisId: 's', delta: body };
      yield { type: 'done', synthesisId: 's', stopReason: 'end_turn', usage };
    },
  };
}

/** A synthesizer that yields `body` split into the given CHUNKS (in order, so
 *  their concatenation === body) across multiple textDelta events — exercises
 *  the streaming path (STATUS prefix forming, incremental + sentence-buffered
 *  deltas). */
function chunkedSynthesizer(chunks: readonly string[]): Synthesizer {
  return {
    async *synthesize(_input: SynthesisInput): AsyncIterable<SynthesisChunk> {
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
      yield { type: 'start', synthesisId: 's', model: 'fake', usage };
      for (const c of chunks) {
        yield { type: 'textDelta', synthesisId: 's', delta: c };
      }
      yield { type: 'done', synthesisId: 's', stopReason: 'end_turn', usage };
    },
  };
}

/** A synthesizer that yields some chunks then THROWS mid-stream (no done). */
function throwingSynthesizer(chunks: readonly string[]): Synthesizer {
  return {
    async *synthesize(_input: SynthesisInput): AsyncIterable<SynthesisChunk> {
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
      yield { type: 'start', synthesisId: 's', model: 'fake', usage };
      for (const c of chunks) {
        yield { type: 'textDelta', synthesisId: 's', delta: c };
      }
      throw new Error('synthesizer blew up mid-stream');
    },
  };
}

function skipClassifier(confidence: number): RelevanceClassifier {
  return {
    classify: vi.fn(
      async (): Promise<RelevanceResult> => ({
        decision: 'skip',
        confidence,
        reason: 'not about our work',
      }),
    ),
  };
}

const hit = (chunkId: string, distance: number | null): HybridHit => ({
  chunk_id: chunkId,
  distance,
  score: 0.5,
  ftsMatched: true,
});

/** Recording sink WITHOUT recordTrace (the prod-like, zero-trace shape). */
class RecordingSink implements PipelineSink {
  readonly cards: PipelineCard[] = [];
  readonly skips: SkipInfo[] = [];
  readonly misses: MissRecord[] = [];
  readonly starts: SynthesisStartInfo[] = [];
  readonly deltas: { synthesisId: string; delta: string }[] = [];
  readonly dones: SynthesisDoneInfo[] = [];
  readonly refusals: SynthesisRefusalInfo[] = [];
  readonly retracts: SynthesisRetractInfo[] = [];
  /** Ordered log of every synthesis lifecycle call, so a test can assert the
   *  start→delta→done|retract SEQUENCE (e.g. deltas fired BEFORE done). */
  readonly seq: ('start' | 'delta' | 'done' | 'refusal' | 'retract')[] = [];
  #seq = 0;

  emitCard(card: PipelineCard): Promise<EmittedCard | null> {
    this.cards.push(card);
    this.#seq += 1;
    return Promise.resolve({ cardId: `card_${String(this.#seq)}` });
  }
  synthesisStart(info: SynthesisStartInfo): void {
    this.starts.push(info);
    this.seq.push('start');
  }
  synthesisDelta(synthesisId: string, delta: string): void {
    this.deltas.push({ synthesisId, delta });
    this.seq.push('delta');
  }
  synthesisDone(info: SynthesisDoneInfo): void {
    this.dones.push(info);
    this.seq.push('done');
  }
  synthesisRefusal(info: SynthesisRefusalInfo): void {
    this.refusals.push(info);
    this.seq.push('refusal');
  }
  synthesisRetract(info: SynthesisRetractInfo): void {
    this.retracts.push(info);
    this.seq.push('retract');
  }
  recordMiss(miss: MissRecord): void {
    this.misses.push(miss);
  }
  recordSkip(info: SkipInfo): void {
    this.skips.push(info);
  }
}

/** A sink that also records traces (the dev/eval shape). */
class TracingSink extends RecordingSink {
  readonly traces: PipelineTrace[] = [];
  recordTrace(trace: PipelineTrace): void {
    this.traces.push(trace);
  }
}

/** Build deps; callers override pieces per scenario. The search fn defaults
 *  to one verbatim-quotable hit; chunk/doc rows back it. */
function makeDeps(over: Partial<PipelineDeps> = {}): {
  deps: PipelineDeps;
  search: ReturnType<typeof vi.fn>;
  embedder: VoyageEmbedder;
} {
  const search = vi.fn(
    async (..._args: Parameters<HybridSearchFn>): Promise<HybridHit[]> => [hit('chunk_1', 0.1)],
  );
  const embedder = over.embedder ?? fakeEmbedder();
  const db =
    over.db ??
    fakeDb(
      [
        {
          chunk_id: 'chunk_1',
          doc_id: 'doc_1',
          domain: 'text',
          text: 'The answer is forty two.',
          position: 0,
          is_summary: false,
        },
      ],
      [{ id: 'doc_1', source: 'github', type: 'doc', title: 'Doc One', url: null }],
    );
  const deps: PipelineDeps = {
    db,
    embedder,
    hybridSearch: search,
    isLowConfidenceHits: () => false,
    optionalReranker: () => undefined,
    optionalQueryExpander: () => undefined,
    dedupeByDoc: (items) => [...items],
    expandWinnersToParents: () => Promise.resolve(new Map()),
    parentDocEnabled: () => false,
    logger: noopLogger,
    topK: 5,
    ...over,
  };
  return { deps, search, embedder };
}

function input(over: Partial<PipelineInput> = {}): PipelineInput {
  return {
    utteranceText: 'What is the answer?',
    utteranceId: 'u1',
    meetingId: 'm1',
    orgId: ORG,
    queryText: 'What is the answer?',
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('runPipeline — query embedding (U1: single embed)', () => {
  it('reuses a provided queryVector and does NOT re-embed', async () => {
    const { deps, search, embedder } = makeDeps();
    const sink = new RecordingSink();
    const vec = Array.from({ length: 3 }, (_, i) => (i === 1 ? 1 : 0));
    await runPipeline(input({ lane: 'question', queryVector: vec }), deps, sink);
    // The question lane already embedded the query text; the core must not embed again.
    expect(embedder.embed).not.toHaveBeenCalled();
    // Retrieval still ran, using the reused vector.
    expect(search).toHaveBeenCalled();
  });

  it('embeds the query text when no queryVector is provided (ambient/legacy)', async () => {
    const { deps, embedder } = makeDeps();
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
  });
});

describe('runPipeline — pre-retrieval gate (KTD3)', () => {
  it('clearly_filler → recordSkip(heuristic) and NO embed/search call', async () => {
    const { deps, search, embedder } = makeDeps();
    const sink = new RecordingSink();
    const result = await runPipeline(input({ utteranceText: 'yeah' }), deps, sink);

    expect(result).toEqual({ emitted: 0, skipped: 'filler' });
    expect(sink.skips).toEqual([{ stage: 'heuristic-gate', reason: 'filler' }]);
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(search.mock.calls).toHaveLength(0);
    expect(sink.cards).toHaveLength(0);
  });

  it('strict substantive judged skip≥threshold → speculative retrieval discarded (U2: no cards, no gap)', async () => {
    const classifier = skipClassifier(0.9);
    const { deps, search, embedder } = makeDeps({
      relevanceClassifier: classifier,
      relevanceStrict: true,
      relevanceSkipThreshold: 0.7,
    });
    const sink = new RecordingSink();
    const result = await runPipeline(input(), deps, sink);

    expect(result).toEqual({ emitted: 0, skipped: 'relevance_skip' });
    expect(sink.skips).toEqual([
      { stage: 'llm-judge', reason: 'not about our work', confidence: 0.9 },
    ]);
    // U2: the judge runs CONCURRENTLY with embed + search, so retrieval runs
    // speculatively even on a filler verdict — the accepted tradeoff. The
    // guarantee is the DISCARD: no cards emitted, no knowledge-gap miss recorded.
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(search.mock.calls).toHaveLength(1);
    expect(sink.cards).toHaveLength(0);
    expect(sink.misses).toHaveLength(0);
  });

  it('U2/AE2: embed+search run CONCURRENTLY with the judge (search fires before the judge resolves)', async () => {
    // A judge whose verdict we control: it stays pending until we resolve it.
    let resolveJudge: (r: RelevanceResult) => void = () => undefined;
    const gate = new Promise<RelevanceResult>((res) => {
      resolveJudge = res;
    });
    const classifier = { classify: vi.fn(() => gate) };
    const { deps, search } = makeDeps({
      relevanceClassifier: classifier as never,
      relevanceStrict: true,
      relevanceSkipThreshold: 0.7,
    });
    const sink = new RecordingSink();
    const runP = runPipeline(input(), deps, sink);

    // Flush microtasks: embed + search should fire while the judge is STILL pending
    // (proves retrieval overlaps the judge rather than waiting for it).
    await new Promise((r) => setTimeout(r, 0));
    expect(search.mock.calls).toHaveLength(1); // ran without the judge having resolved

    resolveJudge({ decision: 'surface' });
    const result = await runP;
    expect(result.emitted).toBe(1); // surface verdict → the speculative retrieval is used
  });

  it('skip below threshold → falls through to embed + search', async () => {
    const classifier = skipClassifier(0.5); // below 0.7
    const { deps, search, embedder } = makeDeps({
      relevanceClassifier: classifier,
      relevanceStrict: true,
    });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    expect(sink.skips).toHaveLength(0);
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(search.mock.calls).toHaveLength(1);
  });

  it('non-strict substantive does NOT route to the judge (classifier untouched)', async () => {
    const classifier = skipClassifier(0.9);
    const { deps } = makeDeps({ relevanceClassifier: classifier, relevanceStrict: false });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    expect((classifier.classify as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(sink.skips).toHaveLength(0);
  });

  // ── QUESTION lane bypass (KTD2 / U4) ──────────────────────────────────────
  it("lane='question' bypasses the heuristic filler skip → embed/search still run", async () => {
    const { deps, search, embedder } = makeDeps();
    const sink = new RecordingSink();
    // 'yeah' is clearly_filler; the question lane must still proceed.
    const result = await runPipeline(input({ utteranceText: 'yeah', lane: 'question' }), deps, sink);

    expect(result.skipped).toBeUndefined();
    expect(sink.skips).toHaveLength(0);
    expect((embedder.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(search.mock.calls).toHaveLength(1);
  });

  it("lane='question' bypasses the about-our-work judge entirely (classifier untouched), even when strict", async () => {
    const classifier = skipClassifier(0.9); // would skip if consulted
    const { deps, search } = makeDeps({
      relevanceClassifier: classifier,
      relevanceStrict: true,
      relevanceSkipThreshold: 0.7,
    });
    const sink = new RecordingSink();
    const result = await runPipeline(input({ lane: 'question' }), deps, sink);

    expect((classifier.classify as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(result.skipped).toBeUndefined();
    expect(search.mock.calls).toHaveLength(1);
  });

  it("lane undefined ⇒ ambient (back-compat): filler still skips", async () => {
    const { deps } = makeDeps();
    const sink = new RecordingSink();
    const result = await runPipeline(input({ utteranceText: 'yeah' }), deps, sink);
    expect(result).toEqual({ emitted: 0, skipped: 'filler' });
  });
});

describe('runPipeline — surface path', () => {
  it('embed → search → dedup → emitCard with rank + score', async () => {
    const { deps, search } = makeDeps();
    const sink = new RecordingSink();
    const result = await runPipeline(input(), deps, sink);

    expect(result.emitted).toBe(1);
    expect(search.mock.calls).toHaveLength(1);
    expect(sink.cards).toHaveLength(1);
    const card = sink.cards[0]!;
    expect(card.rank).toBe(0);
    expect(card.docId).toBe('doc_1');
    expect(card.title).toBe('Doc One');
    // distance 0.1 → 1 - 0.1/2 = 0.95
    expect(card.score).toBeCloseTo(0.95, 5);
  });
});

describe('runPipeline — same-source answer-dedup (Mechanism B)', () => {
  it('duplicate source set → no cards, no synthesis, skipped: duplicate_answer_sources', async () => {
    const synthesizer = fakeSynthesizer('STATUS: answer\nThe answer is [1: "forty two"].');
    const { deps, search } = makeDeps({
      synthesizer,
      // Predicate reports the candidate set as a duplicate.
      isDuplicateAnswerSources: vi.fn((docIds: readonly string[]) => docIds.length > 0),
    });
    const sink = new RecordingSink();
    const result = await runPipeline(input(), deps, sink);

    expect(result).toEqual({ emitted: 0, skipped: 'duplicate_answer_sources' });
    // Search DID run (the dedup is post-retrieval), but no cards/synthesis.
    expect(search.mock.calls).toHaveLength(1);
    expect(sink.cards).toHaveLength(0);
    expect(sink.starts).toHaveLength(0);
    expect(sink.dones).toHaveLength(0);
    expect(sink.skips).toHaveLength(1);
    expect(sink.skips[0]).toEqual({
      stage: 'answer-dedup',
      reason: 'duplicate_answer_sources',
    });
  });

  it('passes the candidate docId set to the predicate', async () => {
    const predicate = vi.fn(() => false);
    const { deps } = makeDeps({ isDuplicateAnswerSources: predicate });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledWith(['doc_1']);
  });

  it('a NEW (non-duplicate) source set is NOT skipped — cards + synthesis run', async () => {
    const { deps } = makeDeps({
      synthesizer: fakeSynthesizer('STATUS: answer\nThe answer is [1: "forty two"].'),
      isDuplicateAnswerSources: () => false,
    });
    const sink = new RecordingSink();
    const result = await runPipeline(input(), deps, sink);
    expect(result.emitted).toBe(1);
    expect(sink.cards).toHaveLength(1);
    expect(sink.dones).toHaveLength(1);
    // Mechanism B record-side: the grounded docIds ride on synthesisDone.
    expect(sink.dones[0]!.sourceDocIds).toEqual(['doc_1']);
  });

  it('no predicate (eval/legacy) → check skipped entirely, surface path unaffected', async () => {
    const { deps } = makeDeps(); // no isDuplicateAnswerSources
    const sink = new RecordingSink();
    const result = await runPipeline(input(), deps, sink);
    expect(result.emitted).toBe(1);
    expect(sink.cards).toHaveLength(1);
    expect(sink.skips).toHaveLength(0);
  });
});

describe('runPipeline — zero hits', () => {
  it('substantive question, 0 hits → recordMiss(no_hits), no card', async () => {
    const search = vi.fn(async () => [] as HybridHit[]);
    const { deps } = makeDeps({ hybridSearch: search as unknown as HybridSearchFn });
    const sink = new RecordingSink();
    const result = await runPipeline(input(), deps, sink);

    expect(result).toEqual({ emitted: 0, skipped: 'no_hits' });
    expect(sink.cards).toHaveLength(0);
    expect(sink.misses).toHaveLength(1);
    expect(sink.misses[0]!.reason).toBe('no_hits');
  });
});

describe('runPipeline — synthesis grounded-or-nothing (U3 streaming)', () => {
  it('grounded answer → synthesisStart/Delta/Done, no miss', async () => {
    const body = 'STATUS: answer\nThe answer is [1: "forty two"].';
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    expect(sink.starts).toHaveLength(1);
    expect(sink.deltas.length).toBeGreaterThanOrEqual(1);
    expect(sink.dones).toHaveLength(1);
    expect(sink.dones[0]!.citations).toHaveLength(1);
    expect(sink.dones[0]!.citations[0]!.cardId).toBe('card_1');
    expect(sink.refusals).toHaveLength(0);
    expect(sink.retracts).toHaveLength(0);
    expect(sink.misses).toHaveLength(0);
  });

  it('GROUNDED answer STREAMS: start + ≥1 delta fire BEFORE done; final text === body', async () => {
    // The source text is "The answer is forty two." — two verbatim-quotable
    // spans across two sentences, delivered in multiple chunks so the STATUS
    // prefix forms across deltas and prose streams incrementally.
    const chunks = [
      'STATUS: an', // prefix still forming — must NOT stream
      'swer\nThe answer is forty [1: "forty two"]. ',
      'It is the answer [1: "The answer is"].',
    ];
    const { deps } = makeDeps({ synthesizer: chunkedSynthesizer(chunks) });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    // Streamed: start + at least one delta fired, and the FIRST done is the
    // LAST event — deltas precede done.
    expect(sink.starts).toHaveLength(1);
    expect(sink.deltas.length).toBeGreaterThanOrEqual(1);
    expect(sink.dones).toHaveLength(1);
    expect(sink.retracts).toHaveLength(0);
    expect(sink.refusals).toHaveLength(0);
    // Sequence: a start, ≥1 delta, then done at the very end.
    expect(sink.seq[0]).toBe('start');
    expect(sink.seq[sink.seq.length - 1]).toBe('done');
    expect(sink.seq.indexOf('delta')).toBeLessThan(sink.seq.lastIndexOf('done'));
    // Multi-chunk stream produced incremental deltas (the first sentence flushed
    // before the second arrived).
    expect(sink.deltas.length).toBeGreaterThanOrEqual(2);
    // The concatenation of all deltas equals the final body (page reconciles).
    const streamed = sink.deltas.map((d) => d.delta).join('');
    expect(streamed).toBe(sink.dones[0]!.text);
    // No part of the STATUS prefix ever leaked into a delta.
    expect(streamed.startsWith('STATUS')).toBe(false);
  });

  it('REFUSAL (STATUS_NO_CONTEXT) is NEVER streamed: no start, no delta', async () => {
    // Deliver the refusal across chunks so a naive streamer would have leaked.
    const chunks = ['STATUS: no_rele', 'vant_context\nNothing here at all.'];
    const { deps } = makeDeps({ synthesizer: chunkedSynthesizer(chunks) });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    // Grounded-or-nothing for the common case: a refusal reveals NOTHING.
    expect(sink.starts).toHaveLength(0);
    expect(sink.deltas).toHaveLength(0);
    expect(sink.dones).toHaveLength(0);
    expect(sink.retracts).toHaveLength(0);
    expect(sink.refusals).toHaveLength(1);
    expect(sink.refusals[0]!.reason).toBe('refusal');
    expect(sink.misses.map((m) => m.reason)).toEqual(['refusal']);
  });

  it('UNGROUNDED (STATUS_ANSWER, citations fail) STREAMS then RETRACTS + recordMiss(ungrounded)', async () => {
    // A STATUS: answer whose quote is NOT in the source → streamed (prose was
    // revealed), then dropped → 0 survivors → retract clears the streamed answer.
    const body = 'STATUS: answer\nThe answer is a fabricated quote nowhere [1: "a fabricated quote nowhere in source"].';
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    // Prose WAS streamed (start + delta), then RETRACTED — not a plain refusal.
    expect(sink.starts).toHaveLength(1);
    expect(sink.deltas.length).toBeGreaterThanOrEqual(1);
    expect(sink.dones).toHaveLength(0);
    expect(sink.refusals).toHaveLength(0);
    expect(sink.retracts).toHaveLength(1);
    expect(sink.retracts[0]!.reason).toBe('ungrounded');
    expect(sink.misses.map((m) => m.reason)).toEqual(['ungrounded']);
    // Retract is the terminal event — nothing grounded persists after it.
    expect(sink.seq[sink.seq.length - 1]).toBe('retract');
  });

  it('SENTENCE-BOUNDARY buffering: deltas break on sentence boundaries, not every token', async () => {
    // Three sentences delivered token-by-token; the streamer must NOT emit a
    // delta per token — it flushes only when a boundary (. ! ?) appears.
    const prose = 'The answer is forty two. It is the answer. Truly the answer [1: "forty two"].';
    const chunks = ['STATUS: answer\n', ...prose.split(' ').map((w) => `${w} `)];
    const { deps } = makeDeps({ synthesizer: chunkedSynthesizer(chunks) });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    expect(sink.starts).toHaveLength(1);
    expect(sink.dones).toHaveLength(1);
    // Far fewer deltas than tokens (~16 words) — proof of sentence buffering,
    // not per-token emission. At most one delta per sentence boundary (+ tail).
    expect(sink.deltas.length).toBeLessThanOrEqual(4);
    expect(sink.deltas.length).toBeGreaterThanOrEqual(1);
    // Every NON-final delta ends at a sentence terminator (boundary-aligned).
    for (let i = 0; i < sink.deltas.length - 1; i += 1) {
      expect(/[.!?\n]\s?$/.test(sink.deltas[i]!.delta)).toBe(true);
    }
  });

  it('SYNTHESIZER ERROR mid-stream → no partial answer left standing (retract + miss)', async () => {
    // Stream a full sentence (so prose is revealed), then throw before done.
    const chunks = ['STATUS: answer\n', 'The answer is forty two. '];
    const { deps } = makeDeps({ synthesizer: throwingSynthesizer(chunks) });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);

    // Prose was streamed, the stream errored before the grounding gate ran, so
    // the revealed answer is retracted — nothing ungrounded stands.
    expect(sink.starts).toHaveLength(1);
    expect(sink.deltas.length).toBeGreaterThanOrEqual(1);
    expect(sink.dones).toHaveLength(0);
    expect(sink.retracts).toHaveLength(1);
    expect(sink.misses.map((m) => m.reason)).toEqual(['refusal']);
  });
});

describe('runPipeline — trace (KTD4/R5)', () => {
  it('trace sink present → one PipelineTrace with per-stage records', async () => {
    const body = 'STATUS: answer\nThe answer is [1: "forty two"].';
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const sink = new TracingSink();
    await runPipeline(input(), deps, sink);

    expect(sink.traces).toHaveLength(1);
    const stages = sink.traces[0]!.stages.map((s) => s.stage);
    // gate (heuristic + llm-judge-skipped) → embed → hybrid-search → crag →
    // dedup-expand → citation-verify → synthesis.
    expect(stages).toContain('heuristic-gate');
    expect(stages).toContain('embed');
    expect(stages).toContain('hybrid-search');
    expect(stages).toContain('dedup-expand');
    expect(stages).toContain('synthesis');
    expect(stages).toContain('citation-verify');
    // Every record carries a status + latency.
    for (const rec of sink.traces[0]!.stages) {
      expect(['ran', 'skipped', 'short_circuited']).toContain(rec.status);
      expect(typeof rec.latencyMs).toBe('number');
    }
  });

  it('filler short-circuit still emits a trace with the gate skip record', async () => {
    const { deps } = makeDeps();
    const sink = new TracingSink();
    await runPipeline(input({ utteranceText: 'yeah' }), deps, sink);

    expect(sink.traces).toHaveLength(1);
    const gate = sink.traces[0]!.stages.find((s) => s.stage === 'heuristic-gate')!;
    expect(gate.status).toBe('short_circuited');
    expect(gate.reason).toBe('clearly_filler');
  });

  it('trace sink ABSENT → no trace work observable (no recordTrace, nothing thrown)', async () => {
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer('STATUS: answer\n[1: "forty two"]') });
    const sink = new RecordingSink();
    // RecordingSink has no recordTrace property at all.
    expect((sink as PipelineSink).recordTrace).toBeUndefined();
    const result = await runPipeline(input(), deps, sink);
    expect(result.emitted).toBe(1);
    // Nothing trace-shaped leaked onto the sink.
    expect(Object.prototype.hasOwnProperty.call(sink, 'traces')).toBe(false);
  });

  // ── U1: the enriched (full) stage set ──
  it('grounded trace carries the new discrete stages (empty-query, router, no-hits, emit, skill, refusal-gate, reveal)', async () => {
    const body = 'STATUS: answer\nThe answer is [1: "forty two"].';
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const sink = new TracingSink();
    await runPipeline(input(), deps, sink);

    const byId = new Map(sink.traces[0]!.stages.map((s) => [s.stage, s]));
    for (const id of ['empty-query', 'router', 'no-hits', 'emit', 'skill', 'refusal-gate', 'reveal'] as const) {
      expect(byId.has(id)).toBe(true);
    }
    expect(byId.get('empty-query')!.decision).toBe('pass');
    expect(byId.get('router')!.decision).toBe('not_fired'); // not tool-shaped
    expect(byId.get('no-hits')!.decision).toBe('pass'); // hits present
    expect(byId.get('emit')!.decision).toBe('emitted');
    expect((byId.get('emit')!.data as { emitted: number }).emitted).toBe(1);
    expect(byId.get('skill')!.decision).toBe('none'); // router not fired
    expect(byId.get('refusal-gate')!.decision).toBe('pass');
    expect(byId.get('reveal')!.decision).toBe('revealed');
  });

  it('miss → no-hits short-circuits (decision miss), downstream stages absent', async () => {
    const search = vi.fn(async () => [] as HybridHit[]);
    const { deps } = makeDeps({ hybridSearch: search as unknown as HybridSearchFn });
    const sink = new TracingSink();
    await runPipeline(input(), deps, sink);

    const byId = new Map(sink.traces[0]!.stages.map((s) => [s.stage, s]));
    const nohits = byId.get('no-hits')!;
    expect(nohits.status).toBe('short_circuited');
    expect(nohits.decision).toBe('miss');
    expect((nohits.data as { recordedGap: boolean }).recordedGap).toBe(true);
    // Past the stop: nothing emitted/synthesized.
    expect(byId.has('emit')).toBe(false);
    expect(byId.has('reveal')).toBe(false);
    expect(byId.has('synthesis')).toBe(false);
  });

  it('ungrounded → refusal-gate passes, citation-verify decision ungrounded, no reveal', async () => {
    const body = 'STATUS: answer\nThe answer is [1: "a fabricated quote nowhere in source"].';
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const sink = new TracingSink();
    await runPipeline(input(), deps, sink);

    const byId = new Map(sink.traces[0]!.stages.map((s) => [s.stage, s]));
    expect(byId.get('refusal-gate')!.decision).toBe('pass');
    expect(byId.get('citation-verify')!.decision).toBe('ungrounded');
    expect((byId.get('citation-verify')!.data as { surviving: number }).surviving).toBe(0);
    expect(byId.has('reveal')).toBe(false);
  });

  it('refusal → refusal-gate short-circuits (decision refusal), no reveal', async () => {
    const body = 'STATUS: no_relevant_context\nNothing here.';
    const { deps } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const sink = new TracingSink();
    await runPipeline(input(), deps, sink);

    const byId = new Map(sink.traces[0]!.stages.map((s) => [s.stage, s]));
    const refusal = byId.get('refusal-gate')!;
    expect(refusal.status).toBe('short_circuited');
    expect(refusal.decision).toBe('refusal');
    expect(byId.has('reveal')).toBe(false);
    // synthesis (generation) still ran before the refusal gate.
    expect(byId.get('synthesis')!.decision).toBe('generated');
  });

  it('empty query → empty-query short-circuit, single trace, nothing downstream', async () => {
    const { deps } = makeDeps();
    const sink = new TracingSink();
    const result = await runPipeline(input({ queryText: '   ' }), deps, sink);

    expect(result).toEqual({ emitted: 0, skipped: 'empty_query' });
    expect(sink.traces).toHaveLength(1);
    const stages = sink.traces[0]!.stages;
    expect(stages).toHaveLength(1);
    expect(stages[0]!.stage).toBe('empty-query');
    expect(stages[0]!.status).toBe('short_circuited');
  });

  it('zero-cost: new stages add no observable work when recordTrace is absent (outputs identical to baseline)', async () => {
    const body = 'STATUS: answer\nThe answer is [1: "forty two"].';
    // Trace ON vs OFF must produce identical sink outputs (cards, dones, misses).
    const { deps: depsOn } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const { deps: depsOff } = makeDeps({ synthesizer: fakeSynthesizer(body) });
    const tracing = new TracingSink();
    const plain = new RecordingSink();
    await runPipeline(input(), depsOn, tracing);
    await runPipeline(input(), depsOff, plain);

    expect((plain as PipelineSink).recordTrace).toBeUndefined();
    expect(plain.cards).toHaveLength(tracing.cards.length);
    expect(plain.dones).toHaveLength(tracing.dones.length);
    expect(plain.misses).toHaveLength(tracing.misses.length);
    expect(plain.dones[0]!.citations).toHaveLength(tracing.dones[0]!.citations.length);
  });
});

describe('runPipeline — topK honored', () => {
  it('passes deps.topK as the search limit', async () => {
    const { deps, search } = makeDeps({ topK: 7 });
    const sink = new RecordingSink();
    await runPipeline(input(), deps, sink);
    expect(search.mock.calls[0]![0].limit).toBe(7);
  });

  it('defaults to the canonical topK (5) when unset', async () => {
    const { deps, search } = makeDeps();
    // Strip the explicit topK so the core's DEFAULT_TOP_K applies.
    const { topK: _omit, ...rest } = deps;
    void _omit;
    const sink = new RecordingSink();
    await runPipeline(input(), rest, sink);
    expect(search.mock.calls[0]![0].limit).toBe(5);
  });
});
