import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VoyageEmbedder, EmbedRequest, EmbedResult } from '@risezome/engine/embed';
import type { RelevanceClassifier, RelevanceResult } from '@risezome/engine/relevance';
import type { MissRecord } from '@risezome/engine/gaps';
import { runPipeline } from '../../src/pipeline/core.js';
import { createWsSink } from '../../src/pipeline/sink-ws.js';
import type {
  PipelineCard,
  PipelineDeps,
  PipelineInput,
  PipelineSink,
  PipelineTrace,
  EmittedCard,
  SynthesisStartInfo,
  SynthesisDoneInfo,
  SynthesisRefusalInfo,
  SynthesisRetractInfo,
  SkipInfo,
  HybridSearchFn,
} from '../../src/pipeline/contract.js';
import type { HybridHit } from '../../src/corpus-search.js';

/**
 * Dev WS sink (U3). Characterizes the mapping from the sink-agnostic core
 * results onto the EXISTING local-debug WS event vocabulary (so the portal
 * client is unchanged) PLUS the new `trace` event. The only behavioral
 * difference from the prod sink is that this one DEFINES recordTrace.
 */

interface Sent {
  type: string;
  [k: string]: unknown;
}

/** A WebSocket stub that records everything `send`-ed. `readyState` 1 = OPEN. */
function recordingSocket(): { socket: WebSocket; sent: Sent[] } {
  const sent: Sent[] = [];
  const socket = {
    readyState: 1,
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as Sent);
    },
  } as unknown as WebSocket;
  return { socket, sent };
}

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

describe('createWsSink — trace ON (the dev-vs-prod difference)', () => {
  it('DEFINES recordTrace (unlike the prod sink), so the core emits a trace', () => {
    const { socket } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    expect(sink.recordTrace).toBeDefined();
  });
});

describe('emitCard → `card` event', () => {
  it('maps the core card onto the existing card event shape the page renders', async () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });

    const result = await sink.emitCard(makeCard());

    const card = sent.find((e) => e.type === 'card');
    expect(card).toBeDefined();
    expect(card?.docId).toBe('doc_a');
    expect(card?.docType).toBe('issue'); // core `type` → page `docType`
    expect(card?.source).toBe('github');
    expect(card?.title).toBe('Doc A');
    expect(card?.snippet).toBe('snip');
    expect(card?.body).toBe('body');
    expect(card?.isSummary).toBe(false);
    expect(card?.traceId).toBe('trace_1');
    expect(card?.utteranceId).toBe('utt_1');
    // page displays a 1-indexed rank ([1], [2], …).
    expect(card?.rank).toBe(1);
    // distance lifted from metadata so the page derives `1 - distance`.
    expect(card?.distance).toBe(0.4);
    // emitCard returns the SAME cardId the event carried so citations resolve.
    expect(result?.cardId).toBe(card?.cardId);
  });

  it('omits distance for an FTS-only hit (no cosine distance in metadata)', async () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    await sink.emitCard(makeCard({ metadata: { distance: null } }));
    const card = sent.find((e) => e.type === 'card');
    expect(card).toBeDefined();
    expect(card).not.toHaveProperty('distance');
  });
});

describe('recordSkip → `retrieval-skip` event', () => {
  it('maps a heuristic-gate skip to reason heuristic-filler', () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    sink.recordSkip({ stage: 'heuristic-gate', reason: 'filler' });
    const skip = sent.find((e) => e.type === 'retrieval-skip');
    expect(skip).toBeDefined();
    expect(skip?.reason).toBe('heuristic-filler');
  });

  it('maps an llm-judge skip to reason classifier-skip with confidence', () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    sink.recordSkip({ stage: 'llm-judge', reason: 'not our work', confidence: 0.9 });
    const skip = sent.find((e) => e.type === 'retrieval-skip');
    expect(skip?.reason).toBe('classifier-skip');
    expect(skip?.confidence).toBe(0.9);
    expect(skip?.detail).toBe('not our work');
  });
});

describe('synthesis events', () => {
  it('synthesisStart/Delta/Done map onto the existing events + close the loop', () => {
    const { socket, sent } = recordingSocket();
    const grounded: string[] = [];
    const sink = createWsSink({
      socket,
      synthesisId: 'synth_handler',
      logger: noopLogger,
      onComplete: (t) => grounded.push(t),
    });

    sink.synthesisStart({
      synthesisId: 'synth_core', // core's internal id
      sourceCardIds: ['c1'],
      traceId: 'trace_1',
      utteranceId: 'utt_1',
    });
    sink.synthesisDelta('synth_core', 'The answer.');
    const done: SynthesisDoneInfo = {
      synthesisId: 'synth_core',
      text: 'The answer.',
      citations: [{ rank: 1, cardId: 'c1', position: 0 }],
      stopReason: 'end_turn',
      latencyMs: 42,
      utteranceId: 'utt_1',
    };
    sink.synthesisDone(done);

    const start = sent.find((e) => e.type === 'synthesisStart');
    const delta = sent.find((e) => e.type === 'synthesisDelta');
    const doneEv = sent.find((e) => e.type === 'synthesisDone');
    // Every synthesis event carries the HANDLER's id (the page's abort plumbing
    // keys on it), not the core's internal id.
    expect(start?.synthesisId).toBe('synth_handler');
    expect(delta?.synthesisId).toBe('synth_handler');
    expect(doneEv?.synthesisId).toBe('synth_handler');
    expect(delta?.delta).toBe('The answer.');
    expect(doneEv?.accumulatedText).toBe('The answer.');
    expect(doneEv?.citations).toEqual([{ rank: 1, cardId: 'c1', position: 0 }]);
    // closed the loop with the grounded body.
    expect(grounded).toEqual(['The answer.']);
  });

  it('synthesisRefusal maps to a synthesisRefusal event with a reason string', () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_handler', logger: noopLogger });
    const refusal: SynthesisRefusalInfo = {
      synthesisId: 'synth_core',
      reason: 'ungrounded',
      latencyMs: 30,
      utteranceId: 'utt_1',
      traceId: 'trace_1',
    };
    sink.synthesisRefusal(refusal);
    const ev = sent.find((e) => e.type === 'synthesisRefusal');
    expect(ev).toBeDefined();
    expect(ev?.synthesisId).toBe('synth_handler');
    expect(String(ev?.accumulatedText)).toMatch(/ungrounded/i);
    expect(ev?.citations).toEqual([]);
  });

  it('synthesisRetract maps to a synthesisRetract event on the handler id (clears the streamed answer)', () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_handler', logger: noopLogger });
    const retract: SynthesisRetractInfo = {
      synthesisId: 'synth_core',
      reason: 'ungrounded',
      latencyMs: 30,
      utteranceId: 'utt_1',
      traceId: 'trace_1',
    };
    sink.synthesisRetract(retract);
    const ev = sent.find((e) => e.type === 'synthesisRetract');
    expect(ev).toBeDefined();
    // Rewritten onto the handler's id so the page's abort/clear logic matches.
    expect(ev?.synthesisId).toBe('synth_handler');
  });
});

describe('recordSkillResult → `skillResult` event', () => {
  it('DEFINES recordSkillResult (the dev card; prod/eval omit it)', () => {
    const { socket } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    expect(sink.recordSkillResult).toBeDefined();
  });

  it('emits the standalone skillResult event in the exact pre-U3 shape', () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    sink.recordSkillResult?.({
      traceId: 'trace_7',
      utteranceId: 'utt_7',
      skillName: 'github_count',
      args: { state: 'open' },
      kind: 'count',
      summary: '12 open issues',
      items: [{ title: 'issue-1', url: 'https://x/1' }],
    });
    const ev = sent.find((e) => e.type === 'skillResult');
    expect(ev).toBeDefined();
    expect(ev?.traceId).toBe('trace_7');
    expect(ev?.utteranceId).toBe('utt_7');
    expect(ev?.skillName).toBe('github_count');
    expect(ev?.args).toEqual({ state: 'open' });
    expect(ev?.kind).toBe('count');
    expect(ev?.summary).toBe('12 open issues');
    expect(ev?.items).toEqual([{ title: 'issue-1', url: 'https://x/1' }]);
  });
});

describe('recordTrace → `trace` event', () => {
  it('emits a trace event carrying the per-stage records', () => {
    const { socket, sent } = recordingSocket();
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    const trace: PipelineTrace = {
      traceId: 'trace_9',
      utteranceId: 'utt_9',
      meetingId: 'org_9',
      stages: [
        { stage: 'heuristic-gate', status: 'ran', latencyMs: 1, decision: 'ambiguous' },
        {
          stage: 'llm-judge',
          status: 'short_circuited',
          latencyMs: 12,
          decision: 'skip',
          reason: 'not our work',
          data: { confidence: 0.92 },
        },
      ],
    };
    sink.recordTrace?.(trace);
    const ev = sent.find((e) => e.type === 'trace');
    expect(ev).toBeDefined();
    expect(ev?.traceId).toBe('trace_9');
    expect(ev?.utteranceId).toBe('utt_9');
    const stages = ev?.stages as PipelineTrace['stages'];
    expect(stages).toHaveLength(2);
    expect(stages[0]?.stage).toBe('heuristic-gate');
    expect(stages[1]?.stage).toBe('llm-judge');
    expect(stages[1]?.status).toBe('short_circuited');
    expect(stages[1]?.reason).toBe('not our work');
  });
});

describe('a non-OPEN socket drops sends (no throw)', () => {
  it('does not send when readyState !== 1', () => {
    const sent: Sent[] = [];
    const socket = {
      readyState: 3, // CLOSED
      send: (raw: string) => sent.push(JSON.parse(raw) as Sent),
    } as unknown as WebSocket;
    const sink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    sink.recordSkip({ stage: 'heuristic-gate', reason: 'filler' });
    expect(sent).toHaveLength(0);
  });
});

// ── Parity: the dev sidecar runs the SAME core as prod ──────────────────────
//
// The U3 win: because the gate lives in the shared core, the dev sidecar and
// prod make the SAME surface/suppress decision for a given utterance. We drive
// the ACTUAL core (`runPipeline`) through BOTH the WS sink (dev) and a recording
// sink (prod-like) with strict routing on, and assert they short-circuit
// identically — and that the dev WS sink emits `retrieval-skip` + a `trace`
// whose llm-judge stage shows the skip, and NO `card`.

const ORG = 'org_1';

function fakeEmbedder(): { embedder: VoyageEmbedder; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(
    async (_req: EmbedRequest): Promise<EmbedResult> => ({
      vectors: [{ index: 0, vector: new Float32Array([0.1, 0.2, 0.3]), cached: false }],
      dimension: 3,
      inputTokens: 1,
      cacheHits: 0,
    }),
  );
  return { embedder: { dimension: 3, embed } as unknown as VoyageEmbedder, embed };
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

/** Prod-like recording sink WITHOUT recordTrace (mirrors core.test.ts). */
class RecordingSink implements PipelineSink {
  readonly cards: PipelineCard[] = [];
  readonly skips: SkipInfo[] = [];
  emitCard(card: PipelineCard): Promise<EmittedCard | null> {
    this.cards.push(card);
    return Promise.resolve({ cardId: 'card_x' });
  }
  synthesisStart(_info: SynthesisStartInfo): void {}
  synthesisDelta(_id: string, _delta: string): void {}
  synthesisDone(_info: SynthesisDoneInfo): void {}
  synthesisRefusal(_info: SynthesisRefusalInfo): void {}
  synthesisRetract(_info: SynthesisRetractInfo): void {}
  recordMiss(_miss: MissRecord): void {}
  recordSkip(info: SkipInfo): void {
    this.skips.push(info);
  }
}

function strictDeps(over: Partial<PipelineDeps>): {
  deps: PipelineDeps;
  search: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(
    async (..._args: Parameters<HybridSearchFn>): Promise<HybridHit[]> => [],
  );
  const { embedder, embed } = fakeEmbedder();
  const deps: PipelineDeps = {
    db: { from: () => ({}) } as unknown as SupabaseClient,
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
    relevanceStrict: true,
    relevanceSkipThreshold: 0.7,
    ...over,
  };
  return { deps, search, embed };
}

function gatedInput(): PipelineInput {
  return {
    utteranceText: 'What is the answer to the substantive question?',
    utteranceId: 'utt_g',
    meetingId: ORG,
    orgId: ORG,
    queryText: 'What is the answer to the substantive question?',
  };
}

// ── Item B: the hybrid-search trace stage carries its OWN ranked hits ───────
//
// Drive the real core through the WS sink with a search that returns hits +
// chunk/doc enrichment, and assert the emitted `trace` event's hybrid-search
// stage carries `data.hits` (the self-contained ranked set) — not just a count
// — so a persisted/after-the-fact trace is renderable without the `card` events.

function fakeDbWithRows(chunkRows: object[], docRows: object[]): SupabaseClient {
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

describe('hybrid-search trace carries its own ranked hits (self-contained)', () => {
  it('the `trace` event hybrid-search stage data carries hits[] + count', async () => {
    const { socket, sent } = recordingSocket();
    const wsSink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    const search = vi.fn(
      async (..._a: Parameters<HybridSearchFn>): Promise<HybridHit[]> => [
        { chunk_id: 'chunk_1', distance: 0.1, score: 0.42, ftsMatched: true },
      ],
    );
    const db = fakeDbWithRows(
      [{ chunk_id: 'chunk_1', doc_id: 'doc_1', domain: 'text', text: 'forty two', position: 0, is_summary: true }],
      [{ id: 'doc_1', source: 'github', type: 'doc', title: 'Doc One', url: null }],
    );
    const { deps } = strictDeps({
      db,
      hybridSearch: search,
      relevanceStrict: false, // no classifier needed: heuristic alone surfaces
    });

    await runPipeline(
      {
        utteranceText: 'What is the answer to the substantive question?',
        utteranceId: 'utt_h',
        meetingId: ORG,
        orgId: ORG,
        queryText: 'What is the answer to the substantive question?',
      },
      deps,
      wsSink,
    );

    const trace = sent.find((e) => e.type === 'trace');
    expect(trace).toBeDefined();
    const stages = trace?.stages as PipelineTrace['stages'];
    const hybrid = stages.find((s) => s.stage === 'hybrid-search');
    expect(hybrid).toBeDefined();
    const data = hybrid?.data as { hits: unknown[]; count: number };
    expect(data.count).toBe(1);
    expect(Array.isArray(data.hits)).toBe(true);
    const h0 = data.hits[0] as Record<string, unknown>;
    expect(h0.rank).toBe(1); // 1-indexed, matching the card event
    expect(h0.title).toBe('Doc One');
    expect(h0.distance).toBe(0.1);
    expect(h0.ftsMatched).toBe(true);
    expect(h0.isSummary).toBe(true);
    expect(typeof h0.score).toBe('number'); // derived [0,1] similarity
  });
});

describe('dev/prod parity — shared core, same surface/suppress decision', () => {
  it('a gated utterance: WS sink → retrieval-skip + trace(gate skip), no card; prod sink → same skip, no embed/search', async () => {
    // Dev side: real core + WS sink.
    const { socket, sent } = recordingSocket();
    const wsSink = createWsSink({ socket, synthesisId: 'synth_1', logger: noopLogger });
    const dev = strictDeps({ relevanceClassifier: skipClassifier(0.9) });
    const devResult = await runPipeline(gatedInput(), dev.deps, wsSink);

    // Prod-like side: real core + recording sink, same deps shape.
    const prodSink = new RecordingSink();
    const prod = strictDeps({ relevanceClassifier: skipClassifier(0.9) });
    const prodResult = await runPipeline(gatedInput(), prod.deps, prodSink);

    // PARITY: identical short-circuit decision.
    expect(devResult).toEqual(prodResult);
    expect(devResult.skipped).toBe('relevance_skip');

    // Dev WS events: a retrieval-skip, a trace, and NO card.
    expect(sent.some((e) => e.type === 'card')).toBe(false);
    const skip = sent.find((e) => e.type === 'retrieval-skip');
    expect(skip?.reason).toBe('classifier-skip');
    const trace = sent.find((e) => e.type === 'trace');
    expect(trace).toBeDefined();
    const stages = trace?.stages as PipelineTrace['stages'];
    const judge = stages.find((s) => s.stage === 'llm-judge');
    expect(judge?.status).toBe('short_circuited');
    expect(judge?.decision).toBe('skip');

    // Prod-like: same skip. U2: the judge runs CONCURRENTLY with embed+search,
    // so retrieval runs speculatively even on a gated verdict — the guarantee is
    // the DISCARD (no card emitted), not "retrieval never ran".
    expect(prodSink.cards).toHaveLength(0);
    expect(prodSink.skips[0]?.stage).toBe('llm-judge');
    expect(dev.embed.mock.calls.length).toBeGreaterThan(0);
    expect(dev.search.mock.calls).toHaveLength(1);
  });
});
