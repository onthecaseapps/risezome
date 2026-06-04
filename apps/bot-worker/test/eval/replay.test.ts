import { describe, expect, it, vi } from 'vitest';
import {
  bucketOf,
  computeRecall,
  evaluateAnswer,
  evaluateQuestion,
  expectsSuppression,
  loadGoldenSet,
  scoreQuestion,
  summarize,
  summarizePrecision,
  validateGoldenSet,
  type EvalBucket,
  type EvalDeps,
  type EvalQuestionView,
  type GoldenQuestion,
  type RetrievedDoc,
} from '../../eval/lib/corpus-replay.js';

function doc(over: Partial<RetrievedDoc> = {}): RetrievedDoc {
  return { chunkId: 'c1', docId: 'github:o/r:README.md@abc', title: 'README.md', score: 0.5, ...over };
}

describe('computeRecall', () => {
  it('matches must-surface labels against docId OR title (case-insensitive)', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ docId: 'x:corpus-search.ts', title: 'corpus-search.ts' })];
    const out = computeRecall(retrieved, ['readme', 'CORPUS-SEARCH']);
    expect(out.recall).toBe(1);
    expect(out.surfaced).toEqual(['readme', 'CORPUS-SEARCH']);
    expect(out.missed).toEqual([]);
  });

  it('reports partial recall and the missed labels', () => {
    const out = computeRecall([doc({ title: 'README.md' })], ['readme', 'voyage', 'deepgram']);
    expect(out.recall).toBeCloseTo(1 / 3);
    expect(out.surfaced).toEqual(['readme']);
    expect(out.missed).toEqual(['voyage', 'deepgram']);
  });

  it('returns null recall when nothing is labeled', () => {
    expect(computeRecall([doc()], []).recall).toBeNull();
    expect(computeRecall([doc()], undefined).recall).toBeNull();
  });
});

describe('evaluateAnswer', () => {
  it('is true only when every expected substring is present (case-insensitive)', () => {
    expect(evaluateAnswer('Uses Claude Haiku and Voyage', ['haiku', 'voyage'])).toBe(true);
    expect(evaluateAnswer('Uses Claude Haiku only', ['haiku', 'voyage'])).toBe(false);
  });
  it('is null when nothing is expected', () => {
    expect(evaluateAnswer('anything', undefined)).toBeNull();
  });
});

describe('scoreQuestion', () => {
  const q: GoldenQuestion = {
    q: 'what ai models are used',
    must_surface: ['readme', 'voyage'],
    expect_answer_contains: ['Haiku', 'Voyage'],
  };

  it('passes when no refusal and the answer contains all expected substrings', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ title: 'voyage.ts' })];
    const r = scoreQuestion(q, retrieved, 'We use Claude Haiku and Voyage embeddings.', false);
    expect(r.pass).toBe(true);
    expect(r.recall).toBe(1);
    expect(r.answerContainsAll).toBe(true);
  });

  it('does NOT fail on a missing must-surface doc when the answer is correct (recall is informational, non-gating)', () => {
    const retrieved = [doc({ title: 'README.md' })]; // voyage doc missing from retrieval
    const r = scoreQuestion(q, retrieved, 'We use Claude Haiku and Voyage.', false);
    expect(r.pass).toBe(true); // answer is correct — the brittle keyword miss must not fail it
    expect(r.recall).toBeCloseTo(0.5); // still reported as a retrieval signal
    expect(r.missed).toEqual(['voyage']);
  });

  it('fails when the system refuses an answerable question', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ title: 'voyage.ts' })];
    const r = scoreQuestion(q, retrieved, '', true);
    expect(r.pass).toBe(false);
    expect(r.isRefusal).toBe(true);
  });

  it('fails when the answer omits an expected substring even with full recall', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ title: 'voyage.ts' })];
    const r = scoreQuestion(q, retrieved, 'We use Claude Haiku.', false); // no Voyage
    expect(r.pass).toBe(false);
    expect(r.answerContainsAll).toBe(false);
  });

  it('expect_refusal question passes iff the system refuses', () => {
    const refusalQ: GoldenQuestion = { q: 'lunch?', expect_refusal: true };
    expect(scoreQuestion(refusalQ, [], '', true).pass).toBe(true);
    expect(scoreQuestion(refusalQ, [doc()], 'some answer', false).pass).toBe(false);
  });

  it('unlabeled non-refusal question passes on any grounded answer', () => {
    const bareQ: GoldenQuestion = { q: 'how does X work' };
    expect(scoreQuestion(bareQ, [doc()], 'X works like so.', false).pass).toBe(true);
    expect(scoreQuestion(bareQ, [doc()], '', true).pass).toBe(false);
  });
});

describe('summarize', () => {
  it('aggregates pass-rate and mean recall over labeled questions', () => {
    const qLabeled: GoldenQuestion = { q: 'a', must_surface: ['x'] };
    const qUnlabeled: GoldenQuestion = { q: 'b' };
    const results = [
      scoreQuestion(qLabeled, [doc({ title: 'x' })], 'ans', false), // pass (no refusal), recall 1
      scoreQuestion(qLabeled, [doc({ title: 'y' })], '', true), // fail (refusal), recall 0
      scoreQuestion(qUnlabeled, [doc()], 'ans', false), // pass, recall null
    ];
    const s = summarize(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.meanRecall).toBeCloseTo(0.5); // (1 + 0) / 2 over labeled, null excluded
  });

  it('handles an empty result set', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.meanRecall).toBeNull();
  });
});

// ── U1: three-bucket precision dataset ──────────────────────────────────────

describe('bucketOf', () => {
  it('defaults an absent bucket to relevant (back-compat with the original set)', () => {
    expect(bucketOf({ q: 'how does X work', expect_answer_contains: ['x'] })).toBe('relevant');
  });
  it('returns the explicit bucket', () => {
    expect(bucketOf({ q: 'lunch?', bucket: 'offtopic', expect_refusal: true })).toBe('offtopic');
    expect(bucketOf({ q: 'pinecone vs weaviate?', bucket: 'adjacent', expect_refusal: true })).toBe(
      'adjacent',
    );
  });
});

describe('expectsSuppression', () => {
  it('is true for offtopic and adjacent, false for relevant', () => {
    expect(expectsSuppression({ q: 'a', bucket: 'offtopic', expect_refusal: true })).toBe(true);
    expect(expectsSuppression({ q: 'b', bucket: 'adjacent', expect_refusal: true })).toBe(true);
    expect(expectsSuppression({ q: 'c', expect_answer_contains: ['x'] })).toBe(false);
  });
  it('honors an explicit expect_refusal even on an untagged item', () => {
    expect(expectsSuppression({ q: 'd', expect_refusal: true })).toBe(true);
  });
});

describe('validateGoldenSet', () => {
  it('flags a suppress-bucket item missing expect_refusal', () => {
    const errs = validateGoldenSet([{ q: 'x', bucket: 'adjacent' }]);
    expect(errs.join(' ')).toMatch(/adjacent must set expect_refusal/);
  });
  it('flags a relevant item that sets expect_refusal', () => {
    const errs = validateGoldenSet([
      { q: 'x', bucket: 'relevant', expect_refusal: true, expect_answer_contains: ['y'] },
    ]);
    expect(errs.join(' ')).toMatch(/relevant must not set expect_refusal/);
  });
  it('flags a relevant item with no expected answer or surface', () => {
    expect(validateGoldenSet([{ q: 'x' }]).join(' ')).toMatch(/needs expect_answer_contains/);
  });
  it('passes a well-formed three-bucket set', () => {
    expect(
      validateGoldenSet([
        { q: 'how does corpus search work', expect_answer_contains: ['hybrid'] },
        { q: 'lunch?', bucket: 'offtopic', expect_refusal: true },
        { q: 'pinecone vs weaviate?', bucket: 'adjacent', expect_refusal: true },
      ]),
    ).toEqual([]);
  });
});

describe('golden-questions.jsonl (the real dataset)', () => {
  const set = loadGoldenSet();
  it('lints clean (no mislabeled bucket/refusal lines)', () => {
    expect(validateGoldenSet(set)).toEqual([]);
  });
  it('contains all three buckets with suppression negatives present', () => {
    const counts: Record<EvalBucket, number> = { relevant: 0, offtopic: 0, adjacent: 0 };
    for (const q of set) counts[bucketOf(q)] += 1;
    expect(counts.relevant).toBeGreaterThan(40);
    expect(counts.offtopic).toBeGreaterThan(20);
    expect(counts.adjacent).toBeGreaterThan(20);
  });
});

// ── U2: full-path gate + precision metrics ──────────────────────────────────

describe('evaluateQuestion relevance gate', () => {
  it('suppresses clearly-filler before any retrieval (no embed/search call)', async () => {
    const embed = vi.fn();
    const deps = {
      db: {} as never,
      embedder: { embed } as never,
      synthesizer: {} as never,
      orgId: 'org_1',
      judge: null,
    } as unknown as EvalDeps;

    const view = await evaluateQuestion(deps, {
      q: 'yeah',
      bucket: 'offtopic',
      expect_refusal: true,
    });

    expect(embed).not.toHaveBeenCalled(); // gate short-circuited before retrieval
    expect(view.gateSuppressed).toBe(true);
    expect(view.result.isRefusal).toBe(true);
    expect(view.result.pass).toBe(true); // offtopic expect_refusal ⇒ suppression is correct
    expect(view.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── U4: evaluateQuestion runs the SHARED pipeline core ───────────────────────
// These exercise the consolidation (the eval validates prod by construction):
// a relevant question surfaces sources + a scored view; an off-topic/adjacent
// gated question yields gateSuppressed + isRefusal (pass-on-suppress); every
// evaluated question carries a per-stage PipelineTrace.

/** A fake SupabaseClient covering the reads the core does for a hit:
 *  hybridSearch's two rpc legs + the chunk/doc enrichment selects. */
function fakeDb(opts: {
  vector?: { chunk_id: string; distance: number }[];
  chunks?: { chunk_id: string; doc_id: string; text: string; position: number; is_summary: boolean }[];
  docs?: { id: string; source: string; type: string; title: string; url: string | null }[];
}): EvalDeps['db'] {
  const rpc = (fn: string): Promise<{ data: unknown; error: null }> => {
    if (fn === 'search_corpus_vector') return Promise.resolve({ data: opts.vector ?? [], error: null });
    return Promise.resolve({ data: [], error: null }); // fts leg: no lexical hits
  };
  const from = (table: string) => {
    const rows = table === 'docs' ? (opts.docs ?? []) : (opts.chunks ?? []);
    // Chainable .select().in().eq() → resolves to { data, error }.
    const builder: Record<string, unknown> = {};
    const thenable = { data: rows, error: null };
    const chain = () => builder;
    builder.select = chain;
    builder.in = chain;
    builder.eq = chain;
    builder.then = (resolve: (v: typeof thenable) => unknown) => resolve(thenable);
    return builder;
  };
  return { rpc, from } as unknown as EvalDeps['db'];
}

/** A synthesizer that streams a fixed grounded (or refusal) body. */
function fakeSynth(body: string): EvalDeps['synthesizer'] {
  return {
    async *synthesize() {
      yield { type: 'start', synthesisId: 's', model: 'fake', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      yield { type: 'textDelta', synthesisId: 's', delta: body };
      yield { type: 'done', synthesisId: 's', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    },
  } as unknown as EvalDeps['synthesizer'];
}

describe('evaluateQuestion via the shared core', () => {
  it('surfaces sources + a scored view for a relevant question', async () => {
    const sourceText = 'Hybrid retrieval fuses vector and full-text search with reciprocal rank fusion.';
    const deps = {
      db: fakeDb({
        vector: [{ chunk_id: 'c1', distance: 0.1 }], // strong vector hit (under the floor)
        chunks: [{ chunk_id: 'c1', doc_id: 'd1', text: sourceText, position: 0, is_summary: false }],
        docs: [{ id: 'd1', source: 'github', type: 'doc', title: 'corpus-search.ts', url: null }],
      }),
      embedder: { embed: vi.fn().mockResolvedValue({ vectors: [{ vector: new Float32Array([0.1, 0.2]) }] }) },
      // Ground the answer on a verbatim substring of the source.
      synthesizer: fakeSynth('STATUS: answer\nIt fuses vector and full-text search [1: "reciprocal rank fusion"].'),
      orgId: 'org_1',
      judge: null,
    } as unknown as EvalDeps;

    const view = await evaluateQuestion(deps, {
      q: 'how does hybrid retrieval work',
      must_surface: ['corpus-search'],
      expect_answer_contains: ['fuses'],
    });

    expect(view.gateSuppressed).toBe(false);
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]).toMatchObject({ rank: 1, docId: 'd1', title: 'corpus-search.ts', ftsMatched: false });
    expect(view.isRefusal).toBe(false);
    expect(view.suppressed).toBe(false);
    expect(view.answer).toContain('fuses');
    expect(view.citations.length).toBeGreaterThan(0);
    expect(view.result.pass).toBe(true);
    expect(view.result.recall).toBe(1); // corpus-search surfaced
    // The view carries a per-stage trace through the grounded path.
    expect(view.trace).not.toBeNull();
    const stages = view.trace?.stages.map((s) => s.stage) ?? [];
    expect(stages).toContain('hybrid-search');
    expect(stages).toContain('synthesis');
  });

  it('yields gateSuppressed + isRefusal (pass-on-suppress) for an adjacent gated question', async () => {
    const embed = vi.fn();
    const classify = vi.fn().mockResolvedValue({ decision: 'skip', confidence: 0.95, reason: 'not-about-our-work' });
    const deps = {
      db: {} as never,
      embedder: { embed },
      synthesizer: {} as never,
      orgId: 'org_1',
      judge: null,
      relevanceClassifier: { classify },
      relevanceStrict: true, // route the substantive question through the judge
    } as unknown as EvalDeps;

    const view = await evaluateQuestion(deps, {
      q: 'how does pinecone compare to weaviate for vector search',
      bucket: 'adjacent',
      expect_refusal: true,
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(embed).not.toHaveBeenCalled(); // judge skip short-circuited before embed
    expect(view.gateSuppressed).toBe(true);
    expect(view.isRefusal).toBe(true);
    expect(view.sources).toHaveLength(0);
    expect(view.result.pass).toBe(true); // adjacent expect_refusal ⇒ suppression is correct
    // The trace records the gate skip at the llm-judge stage.
    expect(view.trace).not.toBeNull();
    const judge = view.trace?.stages.find((s) => s.stage === 'llm-judge');
    expect(judge?.status).toBe('short_circuited');
    expect(judge?.decision).toBe('skip');
  });
});

describe('summarizePrecision', () => {
  function view(bucket: EvalBucket, surfaced: boolean, latencyMs: number): EvalQuestionView {
    return {
      question: { q: 'x', bucket },
      result: { isRefusal: !surfaced, pass: surfaced ? bucket === 'relevant' : bucket !== 'relevant' },
      latencyMs,
    } as unknown as EvalQuestionView;
  }

  it('computes precision over surfaced items and over-refusal over the relevant bucket', () => {
    const s = summarizePrecision([
      view('relevant', true, 100),
      view('relevant', true, 200),
      view('relevant', true, 300),
      view('relevant', false, 50), // over-refused
      view('offtopic', false, 40),
      view('offtopic', false, 40),
      view('offtopic', true, 40), // false positive (surfaced chit-chat)
      view('adjacent', false, 60),
      view('adjacent', false, 60),
    ]);
    expect(s.surfacedTotal).toBe(4); // 3 relevant + 1 offtopic
    expect(s.precision).toBeCloseTo(3 / 4); // 75%
    expect(s.overRefusal).toBeCloseTo(1 / 4); // 1 of 4 relevant suppressed
    expect(s.byBucket.relevant).toMatchObject({ total: 4, surfaced: 3, suppressed: 1 });
    expect(s.byBucket.offtopic).toMatchObject({ total: 3, surfaced: 1, suppressed: 2 });
    expect(s.byBucket.adjacent).toMatchObject({ total: 2, surfaced: 0, suppressed: 2 });
  });

  it('reports latency p50/p95 from per-item timings', () => {
    const s = summarizePrecision(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) => view('relevant', true, ms)),
    );
    expect(s.latencyP50).toBe(50);
    expect(s.latencyP95).toBe(100);
  });

  it('returns null metrics for an empty set', () => {
    const s = summarizePrecision([]);
    expect(s.precision).toBeNull();
    expect(s.overRefusal).toBeNull();
    expect(s.latencyP50).toBeNull();
  });
});
