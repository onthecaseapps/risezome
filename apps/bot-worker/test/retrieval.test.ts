import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the heavy core + sink so the adapter's TRIGGERING logic is the unit under
// test. runPipeline returning vs. not being called is the "fired vs. skipped"
// signal; its first arg lets us assert the PipelineInput (lane, queryText).
const h = vi.hoisted(() => ({
  runPipeline: vi.fn((_input: unknown, _deps: unknown, _sink: unknown) =>
    Promise.resolve({ emitted: 1 }),
  ),
}));
vi.mock('../src/pipeline/core.js', () => ({ runPipeline: h.runPipeline }));
vi.mock('../src/pipeline/sink-supabase.js', () => ({ createSupabaseSink: () => ({}) }));

import { maybeRetrieveAndEmit, newRetrievalRuntime, type RetrievalRuntime } from '../src/retrieval';
import type { PipelineInput } from '../src/pipeline/contract';

const baseArgs = (runtime: RetrievalRuntime, utteranceText: string) => ({
  runtime,
  utteranceText,
  utteranceId: 'u1',
  meetingId: 'm1',
  orgId: 'o1',
  db: {} as never,
  embedder: { embed: vi.fn() } as never,
  logger: { info: () => undefined, warn: () => undefined },
});

function lastInput(): PipelineInput {
  return h.runPipeline.mock.calls.at(-1)![0] as PipelineInput;
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
    expect(over.skipped).toMatch(/ceiling|cooldown/);
    expect(h.runPipeline).toHaveBeenCalledTimes(6);
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
