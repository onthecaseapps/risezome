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
  return h.runPipeline.mock.calls.at(-1)![0] as unknown as PipelineInput;
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
