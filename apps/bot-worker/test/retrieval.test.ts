import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the heavy core + sink so the adapter's TRIGGERING logic is the unit under
// test. runPipeline returning vs. not being called is the "fired vs. skipped"
// signal; its first arg lets us assert the PipelineInput (lane, queryText).
const h = vi.hoisted(() => ({
  runPipeline: vi.fn((_input: unknown, _deps: unknown, _sink: unknown) =>
    Promise.resolve({ emitted: 1 }),
  ),
  // Captures each createSupabaseSink({...}) arg so a test can fire onGroundedAnswer.
  sinkArgs: [] as { onGroundedAnswer?: (t: string, docIds?: readonly string[]) => void }[],
}));
vi.mock('../src/pipeline/core.js', () => ({ runPipeline: h.runPipeline }));
vi.mock('../src/pipeline/sink-supabase.js', () => ({
  createSupabaseSink: (a: { onGroundedAnswer?: (t: string, docIds?: readonly string[]) => void }) => {
    h.sinkArgs.push(a);
    return {};
  },
}));

import {
  maybeRetrieveAndEmit,
  newRetrievalRuntime,
  type RetrievalRuntime,
  type SinkWiring,
} from '../src/retrieval';
import { QUESTION_DUP_WINDOW_MS } from '../src/pipeline/answer-dedup';
import type { PipelineInput } from '../src/pipeline/contract';

// Deterministic pseudo-embedder: identical text → identical one-hot vector
// (cosine distance 0 ⇒ duplicate); different text → (almost always) a different
// bucket (distance 1 ⇒ not a duplicate).
function fakeEmbedder() {
  return {
    embed: vi.fn((req: { items: { text: string }[] }) => {
      const text = req.items[0]!.text;
      const hash = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
      const vector = new Float32Array(16);
      vector[hash % 16] = 1;
      return Promise.resolve({
        vectors: [{ index: 0, vector, cached: false }],
        dimension: 16,
        inputTokens: 1,
        cacheHits: 0,
      });
    }),
  };
}

// Minimal db mock: the only call retrieval.ts makes on `db` is the U4
// effective-source resolver RPC (once per meeting); return an empty set (the
// mocked runPipeline ignores it anyway).
const fakeDb = () => ({ rpc: vi.fn(() => Promise.resolve({ data: [], error: null })) });

const baseArgs = (runtime: RetrievalRuntime, utteranceText: string) => ({
  runtime,
  utteranceText,
  utteranceId: 'u1',
  meetingId: 'm1',
  orgId: 'o1',
  db: fakeDb() as never,
  embedder: fakeEmbedder() as never,
  logger: { info: () => undefined, warn: () => undefined },
});

/** Simulate the sink reporting a grounded (non-refusal) answer for the last
 *  fire. `docIds` are the grounded source set (Mechanism B); default empty. */
function fireGroundedAnswer(docIds: readonly string[] = []): void {
  h.sinkArgs.at(-1)?.onGroundedAnswer?.('a grounded answer', docIds);
}

function lastInput(): PipelineInput {
  return h.runPipeline.mock.calls.at(-1)![0] as PipelineInput;
}

/** The PipelineDeps the adapter built for the most recent fire (Mechanism B's
 *  isDuplicateAnswerSources predicate lives here). */
function lastDeps(): { isDuplicateAnswerSources?: (docIds: readonly string[]) => boolean } {
  return h.runPipeline.mock.calls.at(-1)![1] as {
    isDuplicateAnswerSources?: (docIds: readonly string[]) => boolean;
  };
}

describe('maybeRetrieveAndEmit — two-lane triggering', () => {
  beforeEach(() => {
    h.runPipeline.mockClear();
  });

  it('AE1: a substantive question fires even inside the 10s cooldown', async () => {
    const rt = newRetrievalRuntime();
    rt.lastRetrievalAt = Date.now() - 3_900; // a filler retrieval 3.9s ago
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    expect(res.skipped).toBeUndefined();
    expect(h.runPipeline).toHaveBeenCalledTimes(1);
    expect(lastInput().lane).toBe('question');
  });

  it('an ambient (non-question) utterance is still throttled by the cooldown', async () => {
    const rt = newRetrievalRuntime();
    rt.lastRetrievalAt = Date.now() - 3_900;
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'so the build is green now'));
    expect(res.skipped).toBe('cooldown');
    expect(h.runPipeline).not.toHaveBeenCalled();
  });

  it('an ambient utterance fires once the cooldown elapses, tagged ambient', async () => {
    const rt = newRetrievalRuntime();
    rt.lastRetrievalAt = Date.now() - 11_000;
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'so the build is green now'));
    expect(res.skipped).toBeUndefined();
    expect(lastInput().lane).toBe('ambient');
  });

  it('AE5: a burst of questions beyond the per-minute ceiling throttles (falls back to cooldown)', async () => {
    const rt = newRetrievalRuntime();
    // Fire MAX_PER_MIN questions back-to-back (all bypass the cooldown).
    for (let i = 0; i < 6; i++) {
      const r = await maybeRetrieveAndEmit(baseArgs(rt, `what is metric number ${String(i)}`));
      expect(r.skipped).toBeUndefined();
    }
    expect(h.runPipeline).toHaveBeenCalledTimes(6);
    // The 7th within the same minute is over the ceiling → throttled by the
    // cooldown it would otherwise bypass (lastRetrievalAt was just set).
    const over = await maybeRetrieveAndEmit(baseArgs(rt, 'what is the next metric'));
    expect(over.skipped).toBe('question_ceiling');
    expect(h.runPipeline).toHaveBeenCalledTimes(6);
  });

  it('AE5: the per-MEETING ceiling throttles (falls back to cooldown) independently of the per-minute window', async () => {
    const rt = newRetrievalRuntime();
    rt.questionFireCount = 60; // at the per-meeting cap; per-minute window empty
    rt.lastRetrievalAt = Date.now() - 1_000; // within the cooldown it falls back to
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what is the answer to this'));
    expect(res.skipped).toBe('question_ceiling');
    expect(h.runPipeline).not.toHaveBeenCalled();
  });

  it('over the per-meeting ceiling, a question still fires once the fallback cooldown elapses (best-effort, not a hard drop)', async () => {
    const rt = newRetrievalRuntime();
    rt.questionFireCount = 60;
    rt.lastRetrievalAt = Date.now() - 11_000; // cooldown elapsed
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what is the answer to this'));
    expect(res.skipped).toBeUndefined();
    expect(h.runPipeline).toHaveBeenCalledTimes(1);
  });

  it('a normal 2-3 question exchange is never throttled', async () => {
    const rt = newRetrievalRuntime();
    for (const q of ['what ai models do we use', 'how does reranking work', 'which embedding model']) {
      const r = await maybeRetrieveAndEmit(baseArgs(rt, q));
      expect(r.skipped).toBeUndefined();
    }
    expect(h.runPipeline).toHaveBeenCalledTimes(3);
  });
});

describe('maybeRetrieveAndEmit — question-anchored query (U3)', () => {
  beforeEach(() => h.runPipeline.mockClear());

  it('AE6: a standalone question amid off-domain finals embeds as JUST the question', async () => {
    const rt = newRetrievalRuntime();
    rt.recentFinals = [
      'i wanna know where they lived at the time of their behavior',
      "the last thing i wanna talk about is ongoing versus historical data",
      "we're running out of time so just one more minute",
    ];
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    // The off-domain finals must NOT leak into the embed query.
    expect(lastInput().queryText).toBe('what ai models do we use');
  });

  it('AE6: a fragment follow-up question pulls in the prior final + summary topic', async () => {
    const rt = newRetrievalRuntime();
    rt.recentFinals = ['the second data enrichment option uses voyage'];
    const args = {
      ...baseArgs(rt, 'what about historically'),
      lastSummary: {
        summary: '',
        current_topic: 'data enrichment options',
        open_questions: [],
        key_terms: [],
      },
    };
    await maybeRetrieveAndEmit(args);
    const q = lastInput().queryText;
    expect(lastInput().lane).toBe('question');
    expect(q).toContain('what about historically');
    expect(q).toContain('second data enrichment option'); // prior final (referent)
    expect(q).toContain('data enrichment options'); // summary topic
  });

  it('U1: a question fire embeds ONCE and threads that vector as queryVector', async () => {
    const rt = newRetrievalRuntime();
    const emb = fakeEmbedder();
    await maybeRetrieveAndEmit({ ...baseArgs(rt, 'what ai models do we use'), embedder: emb as never });
    // The question lane embeds the query text once (for near-duplicate
    // suppression) and threads the vector so the core reuses it (no 2nd embed).
    expect(emb.embed).toHaveBeenCalledTimes(1);
    const vec = lastInput().queryVector;
    expect(vec).toBeDefined();
    expect(vec).toHaveLength(16);
  });

  it('U1: an ambient fire threads NO queryVector (core embeds with the key-terms boost)', async () => {
    const rt = newRetrievalRuntime();
    rt.lastRetrievalAt = Date.now() - 11_000;
    const emb = fakeEmbedder();
    await maybeRetrieveAndEmit({ ...baseArgs(rt, 'so the build is green now'), embedder: emb as never });
    // No dedup embed on the ambient lane → nothing to reuse; the core embeds.
    expect(emb.embed).not.toHaveBeenCalled();
    expect(lastInput().queryVector).toBeUndefined();
  });

  it('an ambient fire keeps the full rolling window', async () => {
    const rt = newRetrievalRuntime();
    rt.lastRetrievalAt = Date.now() - 11_000;
    rt.recentFinals = ['the build is green', 'we ship on friday'];
    await maybeRetrieveAndEmit(baseArgs(rt, 'and the staging deploy went fine'));
    // "and the staging deploy went fine" is a follow-up-shaped statement, but it
    // is NOT a question, so it takes the ambient lane and the full window.
    expect(lastInput().lane).toBe('ambient');
    expect(lastInput().queryText).toBe('the build is green we ship on friday and the staging deploy went fine');
  });
});

describe('maybeRetrieveAndEmit — near-duplicate question suppression (U5)', () => {
  beforeEach(() => {
    h.runPipeline.mockClear();
    h.sinkArgs.length = 0;
  });

  it('AE4: the same question, once answered, is suppressed on re-ask', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    expect(h.runPipeline).toHaveBeenCalledTimes(1);
    fireGroundedAnswer(); // the first answer grounded → recorded for dedup

    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    expect(res.skipped).toBe('duplicate_question');
    expect(h.runPipeline).toHaveBeenCalledTimes(1); // did not fire again
  });

  it('a genuinely different question still fires', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer();
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'how does reranking improve recall'));
    expect(res.skipped).toBeUndefined();
    expect(h.runPipeline).toHaveBeenCalledTimes(2);
  });

  it('a REFUSED question is not recorded, so a genuine re-ask still fires', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    // No fireGroundedAnswer() → the answer was refused, nothing recorded.
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    expect(res.skipped).toBeUndefined();
    expect(h.runPipeline).toHaveBeenCalledTimes(2);
  });

  it('a duplicate outside the recency window fires again', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer();
    // Age the recorded answer past the 5-minute window.
    rt.answeredQuestions[0]!.at = Date.now() - 6 * 60_000;
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    expect(res.skipped).toBeUndefined();
  });

  it('an embed failure degrades to firing (dedup is best-effort, never blocks a question)', async () => {
    const rt = newRetrievalRuntime();
    // Record a prior answer so dedup WOULD suppress if the embed succeeded...
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer();
    // ...but the embed now fails → the question must still fire, not be dropped.
    const args = baseArgs(rt, 'what ai models do we use');
    args.embedder = { embed: vi.fn(() => Promise.reject(new Error('embed down'))) } as never;
    const res = await maybeRetrieveAndEmit(args);
    expect(res.skipped).toBeUndefined();
    expect(h.runPipeline).toHaveBeenCalledTimes(2);
  });

  it('forwards the grounded answer to the caller-supplied onGroundedAnswer', async () => {
    const rt = newRetrievalRuntime();
    const onGroundedAnswer = vi.fn();
    await maybeRetrieveAndEmit({ ...baseArgs(rt, 'what ai models do we use'), onGroundedAnswer });
    fireGroundedAnswer();
    // The adapter forwards only the answer text to the caller (the source docIds
    // are consumed internally for Mechanism B).
    expect(onGroundedAnswer).toHaveBeenCalledWith('a grounded answer');
  });
});

describe('Mechanism A — void already-answered transcript spans', () => {
  beforeEach(() => {
    h.runPipeline.mockClear();
    h.sinkArgs.length = 0;
  });

  it('OLDER answered spans are excluded from the NEXT question’s recentContext; the immediate prior final is retained (anaphora carve-out)', async () => {
    const rt = newRetrievalRuntime();
    // First (ambient-ish) statement establishes a transcript span, then a
    // question is asked and grounds — that span produced the answer.
    rt.recentFinals = ['css question about flexbox alignment'];
    await maybeRetrieveAndEmit(baseArgs(rt, 'how do i center a div'));
    // The effective window for this call = ['css question...', 'how do i center a div'].
    fireGroundedAnswer(['doc-css']);
    // Both texts that produced the grounded answer are now consumed.
    expect(rt.consumedFinals).toContain('css question about flexbox alignment');
    expect(rt.consumedFinals).toContain('how do i center a div');

    // A NEW question fires. Its recentContext must NOT carry the OLDER consumed
    // span, but the immediately-prior final is retained even though consumed —
    // the anaphora carve-out (a follow-up needs its antecedent). The new
    // utterance itself is the query (never voided).
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what database do we use'));
    expect(res.skipped).toBeUndefined();
    const ctx = lastInput().recentContext ?? [];
    expect(ctx).not.toContain('css question about flexbox alignment'); // older span voided
    expect(ctx).toContain('how do i center a div'); // immediate prior retained
    expect(lastInput().queryText).toBe('what database do we use');
  });

  it('the synthesizer window retains ONLY the immediate antecedent; the router window retains the whole raw span', async () => {
    const rt = newRetrievalRuntime();
    // An older span + the question both ground — the whole span is consumed.
    rt.recentFinals = ['we should check the github backlog'];
    await maybeRetrieveAndEmit(baseArgs(rt, 'are there any open github issues'));
    fireGroundedAnswer(['doc-gh']);
    expect(rt.consumedFinals).toContain('we should check the github backlog');
    expect(rt.consumedFinals).toContain('are there any open github issues');

    // The anaphoric follow-up fires. The synthesizer window (recentContext)
    // keeps the immediately-prior final (the antecedent "these issues" needs)
    // but voids the older consumed span; the router window keeps everything.
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'how many of these issues are there'));
    expect(res.skipped).toBeUndefined();
    const ctx = lastInput().recentContext ?? [];
    const routerFinals = lastInput().routerRecentFinals ?? [];
    expect(ctx).toContain('are there any open github issues'); // antecedent retained for synthesis
    expect(ctx).not.toContain('we should check the github backlog'); // older span voided
    expect(routerFinals).toContain('we should check the github backlog'); // raw window for routing
    expect(routerFinals).toContain('are there any open github issues');
  });

  it('a follow-up question’s built query keeps the RAW prior final as its antecedent (even when consumed)', async () => {
    const rt = newRetrievalRuntime();
    rt.recentFinals = ['the css alignment topic'];
    await maybeRetrieveAndEmit(baseArgs(rt, 'how do i center a div'));
    fireGroundedAnswer(['doc-css']);

    // A fragment follow-up pulls in the immediately-prior RAW final as its
    // referent — even though that final is consumed. Voiding it left the
    // follow-up query with either NO antecedent or (worse) an older unrelated
    // one from the effective window; the dedup protection is the near-duplicate
    // check over the BUILT query, not antecedent starvation.
    const args = {
      ...baseArgs(rt, 'what about it'),
      lastSummary: { summary: '', current_topic: 'databases', open_questions: [], key_terms: [] },
    };
    const res = await maybeRetrieveAndEmit(args);
    expect(res.skipped).toBeUndefined();
    const q = lastInput().queryText;
    expect(q).toContain('what about it');
    expect(q).toContain('how do i center a div'); // raw antecedent retained
    expect(q).toContain('databases'); // summary topic still feeds it
  });

  it('a follow-up never picks an OLDER unconsumed utterance as its antecedent', async () => {
    const rt = newRetrievalRuntime();
    // Older unrelated chatter that was never consumed, then a question that
    // grounds (its span is voided).
    rt.recentFinals = ['unrelated lunch plans chatter'];
    await maybeRetrieveAndEmit(baseArgs(rt, 'are there any open github issues'));
    fireGroundedAnswer(['doc-gh']);

    // Pre-fix: the effective window was [unrelated, follow-up], so the
    // follow-up's antecedent slot held the unrelated chatter. The raw prior
    // final (the github question) is the true referent.
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'how many closed'));
    expect(res.skipped).toBeUndefined();
    const q = lastInput().queryText;
    expect(q).toContain('are there any open github issues');
    expect(q).not.toContain('unrelated lunch plans chatter');
  });

  it('the current utterance is never voided even if its exact text was previously consumed', async () => {
    const rt = newRetrievalRuntime();
    // Pre-seed the exact current text into consumedFinals.
    rt.consumedFinals = ['what ai models do we use'];
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    // The query is the current question — keep-last guarantees it survives.
    expect(res.skipped).toBeUndefined();
    expect(lastInput().queryText).toBe('what ai models do we use');
  });
});

describe('Mechanism B — skip a synthesis grounding on an already-answered source set', () => {
  beforeEach(() => {
    h.runPipeline.mockClear();
    h.sinkArgs.length = 0;
  });

  /** Bucket of the fake embedder's one-hot vector for `text`. */
  function bucketOf(text: string): number {
    return [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 16;
  }

  /**
   * A vector at cosine distance 0.25 from the fake embedding of `text`:
   * strictly between the STRICT dedup distance (0.15 — so the pre-retrieval
   * near-dup check does NOT suppress the call) and the LOOSE confirm distance
   * (0.30 — so Mechanism B's rephrase confirmation DOES match). Simulates "the
   * answered question was a moderate rephrase of this one".
   */
  function looseRephraseOf(text: string): number[] {
    const k = bucketOf(text);
    const v = new Array<number>(16).fill(0);
    v[k] = 3;
    v[(k + 1) % 16] = Math.sqrt(7); // cos = 3/4 → distance 0.25
    return v;
  }

  it('a REPHRASED question (loose similarity) whose source set was already answered is flagged duplicate; a new docId is not', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer(['doc-a', 'doc-b']); // records answeredSourceSets

    // The confirmation signal: a recently-ANSWERED question moderately similar
    // to the upcoming re-ask (the one-hot fake can't express "moderate", so the
    // ledger entry is crafted at distance 0.25 — past the strict 0.15 check,
    // within the 0.30 confirm bound).
    rt.answeredQuestions.push({ embedding: looseRephraseOf('remind me which ai models'), at: Date.now() });

    await maybeRetrieveAndEmit(baseArgs(rt, 'remind me which ai models'));
    const pred = lastDeps().isDuplicateAnswerSources;
    expect(pred).toBeDefined();
    expect(pred!(['doc-a', 'doc-b'])).toBe(true); // exact set
    expect(pred!(['doc-b', 'doc-a'])).toBe(true); // order-independent
    expect(pred!(['doc-a'])).toBe(true); // subset adds no new source
    expect(pred!(['doc-a', 'doc-c'])).toBe(false); // doc-c is new
    expect(pred!([])).toBe(false); // empty candidate never dedups
  });

  it('a genuinely DIFFERENT question retrieving the same sources is NOT suppressed (rephrase confirmation required)', async () => {
    const rt = newRetrievalRuntime();
    // Q1 answered, grounding on {doc-a, doc-b}.
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer(['doc-a', 'doc-b']);

    // Q2 is a DIFFERENT question (fake-embed distance 1 from Q1) that happens to
    // retrieve the SAME two docs — e.g. "what's the status of X" then "who owns
    // X". Pre-fix this was suppressed outright (the user saw nothing); now the
    // source-set overlap alone is not enough without a rephrase-similar answered
    // question to confirm.
    const res = await maybeRetrieveAndEmit(baseArgs(rt, 'who is assigned to the auth refactor'));
    expect(res.skipped).toBeUndefined(); // fired (not a near-duplicate question)
    expect(lastDeps().isDuplicateAnswerSources!(['doc-a', 'doc-b'])).toBe(false);
    expect(lastDeps().isDuplicateAnswerSources!(['doc-a'])).toBe(false);
  });

  it('the AMBIENT lane keeps the source-set-only veto (no question vector to confirm with)', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer(['doc-a']);
    // An ambient fire after the cooldown: its predicate has no question vector,
    // so the source-set overlap alone still suppresses (the ambient lane's only
    // dedup).
    rt.lastRetrievalAt = Date.now() - 11_000;
    await maybeRetrieveAndEmit(baseArgs(rt, 'so the build is green now'));
    expect(lastDeps().isDuplicateAnswerSources!(['doc-a'])).toBe(true);
  });

  it('the answered source set expires after the recency window', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer(['doc-a']);
    rt.answeredQuestions.push({ embedding: looseRephraseOf('remind me which ai models'), at: Date.now() });
    // Age the recorded set past the 5-minute window.
    rt.answeredSourceSets[0]!.at = Date.now() - 6 * 60_000;
    await maybeRetrieveAndEmit(baseArgs(rt, 'remind me which ai models'));
    expect(lastDeps().isDuplicateAnswerSources!(['doc-a'])).toBe(false);
  });

  it('a pure tool answer (no source docIds) records no answered source set', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'what ai models do we use'));
    fireGroundedAnswer([]); // grounded but no source docs
    expect(rt.answeredSourceSets).toHaveLength(0);
  });

  it('an AMBIENT grounded answer records into answeredQuestions (lane-flip dedup)', async () => {
    const rt = newRetrievalRuntime();
    await maybeRetrieveAndEmit(baseArgs(rt, 'so the build is green now')); // ambient
    fireGroundedAnswer(['doc-x']);
    // The record is a fire-and-forget embed — let the microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.answeredQuestions).toHaveLength(1);
    expect(rt.answeredSourceSets).toHaveLength(1);
  });
});

describe('maybeRetrieveAndEmit — injected clock + sink factory (U1 seams)', () => {
  beforeEach(() => {
    h.runPipeline.mockClear();
    h.sinkArgs.length = 0;
  });

  it('injected `now` drives the cooldown window (not Date.now)', async () => {
    const rt = newRetrievalRuntime();
    // Logical timestamps far from real Date.now() prove the injected clock is used.
    const a = await maybeRetrieveAndEmit({ ...baseArgs(rt, 'so the build is green now'), now: 1_000_000 });
    expect(a.skipped).toBeUndefined();
    // 5s later (logical) — within the 10s cooldown → skipped.
    const b = await maybeRetrieveAndEmit({ ...baseArgs(rt, 'and the tests pass too now'), now: 1_005_000 });
    expect(b.skipped).toBe('cooldown');
    // 11s after the fire — cooldown elapsed → fires.
    const c = await maybeRetrieveAndEmit({ ...baseArgs(rt, 'deploy looks healthy as well'), now: 1_011_000 });
    expect(c.skipped).toBeUndefined();
  });

  it('injected `now` drives the near-duplicate-question recency window', async () => {
    const rt = newRetrievalRuntime();
    const q1 = await maybeRetrieveAndEmit({ ...baseArgs(rt, 'what ai models do we use'), now: 1_000_000 });
    expect(q1.skipped).toBeUndefined();
    fireGroundedAnswer(); // records the question embedding at logical t=1_000_000
    // Same question 1s later (logical) → near-duplicate → suppressed.
    const q2 = await maybeRetrieveAndEmit({ ...baseArgs(rt, 'what ai models do we use'), now: 1_001_000 });
    expect(q2.skipped).toBe('duplicate_question');
    // Same question past the dup recency window → fires again.
    const q3 = await maybeRetrieveAndEmit({
      ...baseArgs(rt, 'what ai models do we use'),
      now: 1_000_000 + QUESTION_DUP_WINDOW_MS + 1,
    });
    expect(q3.skipped).toBeUndefined();
  });

  it('uses the injected createSink factory instead of the Supabase sink; the wiring still records dedup state', async () => {
    const rt = newRetrievalRuntime();
    let captured: SinkWiring | undefined;
    const createSink = (wiring: SinkWiring): never => {
      captured = wiring;
      return {} as never;
    };
    const res = await maybeRetrieveAndEmit({
      ...baseArgs(rt, 'what ai models do we use'),
      now: 1_000_000,
      createSink,
    });
    expect(res.skipped).toBeUndefined();
    expect(captured).toBeDefined();
    // The Supabase sink was NOT built (the mock would have captured its args).
    expect(h.sinkArgs).toHaveLength(0);
    // The adapter's grounded-answer wiring still records dedup state on the runtime.
    captured!.onGroundedAnswer('a grounded answer', ['doc1']);
    expect(rt.answeredQuestions).toHaveLength(1);
    expect(rt.answeredSourceSets).toHaveLength(1);
    expect(rt.answeredSourceSets[0]!.at).toBe(1_000_000); // recorded with the injected clock
  });

  it('a fresh runtime fires the first AMBIENT utterance even at now=0 (never-fired sentinel)', async () => {
    // Regression: a replay injects now=startMs, and a real meeting's first
    // utterance has startMs≈0. With the old lastRetrievalAt=0 baseline this hit
    // `now - 0 < COOLDOWN_MS` and was spuriously cooldown-suppressed. The
    // NEGATIVE_INFINITY sentinel makes the first fire always pass on any clock.
    const rt = newRetrievalRuntime();
    const res = await maybeRetrieveAndEmit({ ...baseArgs(rt, 'so the build is green now'), now: 0 });
    expect(res.skipped).toBeUndefined();
  });
});

describe('maybeRetrieveAndEmit — unscoped whole-org retrieval (U3 seam)', () => {
  beforeEach(() => {
    h.runPipeline.mockClear();
    h.sinkArgs.length = 0;
  });

  it('unscoped:true SKIPS the meeting_effective_source_ids RPC (whole-org, no source filter)', async () => {
    const rt = newRetrievalRuntime();
    const db = fakeDb();
    const res = await maybeRetrieveAndEmit({
      ...baseArgs(rt, 'what ai models do we use'),
      db: db as never,
      unscoped: true,
    });
    expect(res.skipped).toBeUndefined();
    expect(db.rpc).not.toHaveBeenCalled(); // no scope resolution → whole-org
  });

  it('the default (scoped) path resolves the effective source set via the RPC', async () => {
    const rt = newRetrievalRuntime();
    const db = fakeDb();
    await maybeRetrieveAndEmit({ ...baseArgs(rt, 'what ai models do we use'), db: db as never });
    expect(db.rpc).toHaveBeenCalledWith('meeting_effective_source_ids', { p_meeting_id: 'm1' });
  });
});
