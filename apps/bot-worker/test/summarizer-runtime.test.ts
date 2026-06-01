import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COLD_START_CADENCE,
  DEFAULT_STEADY_CADENCE,
  MeetingSummarizerRuntime,
} from '../src/summarizer-runtime.js';
import type {
  MeetingSummary,
  Summarizer,
  SummarizerInput,
} from '@risezome/engine/summarize';

interface FakeSummarizerOptions {
  /** Resolves with the same canned summary each call (default behavior). */
  readonly response?: MeetingSummary;
  /** Custom per-call handler; overrides `response` when provided. */
  readonly handler?: (input: SummarizerInput) => Promise<MeetingSummary>;
}

function makeSummary(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    summary: 'A summary.',
    current_topic: 'topic',
    open_questions: [],
    key_terms: [],
    ...overrides,
  };
}

function makeFakeSummarizer(opts: FakeSummarizerOptions = {}): {
  summarizer: Summarizer;
  calls: SummarizerInput[];
  resolveNext: (s?: MeetingSummary) => void;
  rejectNext: (e?: unknown) => void;
  pendingCount: () => number;
} {
  const calls: SummarizerInput[] = [];
  const pending: {
    resolve: (s: MeetingSummary) => void;
    reject: (e: unknown) => void;
  }[] = [];

  const summarizer: Summarizer = {
    summarize: async (input: SummarizerInput) => {
      calls.push(input);
      if (opts.handler !== undefined) return opts.handler(input);
      return new Promise<MeetingSummary>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };

  return {
    summarizer,
    calls,
    resolveNext: (s) => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no pending summarize() call to resolve');
      next.resolve(s ?? (opts.response ?? makeSummary()));
    },
    rejectNext: (e) => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no pending summarize() call to reject');
      next.reject(e ?? new Error('summarizer-error'));
    },
    pendingCount: () => pending.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MeetingSummarizerRuntime cadence triggers', () => {
  it('cold-start: pause-debounce fires after 5 utterances + pauseDebounce ms', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });

    // 5 utterances in cold-start triggers the count threshold.
    for (let i = 0; i < 5; i++) {
      rt.recordUtterance(`utterance ${String(i)}`);
      vi.advanceTimersByTime(100); // tight succession; debounce keeps rolling
    }
    // No fire yet — debounce timer hasn't elapsed.
    expect(fake.calls).toHaveLength(0);

    // Advance past pauseDebounceMs (default cold-start = 8s).
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    expect(fake.calls).toHaveLength(1);

    fake.resolveNext(makeSummary({ summary: 'first one' }));
    await vi.runOnlyPendingTimersAsync();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.summary).toBe('first one');

    rt.dispose();
  });

  it('steady-state: N=15 utterance count threshold fires after the first summary', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });

    // Cold-start: get the first summary in fast.
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    fake.resolveNext(makeSummary({ summary: 'first' }));
    await vi.runOnlyPendingTimersAsync();
    expect(updates).toHaveLength(1);

    // Advance past the rate cap so the next fire is allowed.
    vi.advanceTimersByTime(70_000);

    // Now in steady state. 14 utterances should NOT trigger by count.
    for (let i = 0; i < 14; i++) rt.recordUtterance(`s${String(i)}`);
    // Walk the debounce out — only count trigger should be relevant.
    vi.advanceTimersByTime(DEFAULT_STEADY_CADENCE.pauseDebounceMs + 100);
    // Time threshold hasn't elapsed either (only 70s + ~10s < 120s since
    // the first summary).
    expect(fake.calls).toHaveLength(1);

    // 15th utterance hits the count threshold; debounce out and fire.
    rt.recordUtterance('s15');
    vi.advanceTimersByTime(DEFAULT_STEADY_CADENCE.pauseDebounceMs + 100);
    expect(fake.calls).toHaveLength(2);

    rt.dispose();
  });

  it('close-the-loop: recorded assistant answers ride into the summarize input', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => undefined,
    });

    rt.recordAssistantAnswer('The project uses Claude Haiku, Voyage, and Deepgram.');
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.resolved_answers).toEqual([
      'The project uses Claude Haiku, Voyage, and Deepgram.',
    ]);

    rt.dispose();
  });

  it('close-the-loop: keeps only the most recent RESOLVED_ANSWERS_CAP answers', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => undefined,
    });

    for (let i = 0; i < 12; i++) rt.recordAssistantAnswer(`answer ${String(i)}`);
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);

    const answers = fake.calls[0]!.resolved_answers;
    expect(answers).toHaveLength(8); // RESOLVED_ANSWERS_CAP
    expect(answers![0]).toBe('answer 4'); // oldest 4 dropped
    expect(answers![7]).toBe('answer 11');

    rt.dispose();
  });

  it('close-the-loop: omits resolved_answers entirely when none recorded', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => undefined,
    });

    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);

    expect(fake.calls[0]!.resolved_answers).toBeUndefined();

    rt.dispose();
  });

  it('steady-state: time threshold (M=120s) fires even with few utterances', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });

    // First summary out the door.
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    fake.resolveNext();
    await vi.runOnlyPendingTimersAsync();
    expect(fake.calls).toHaveLength(1);

    // Wait past rate cap.
    vi.advanceTimersByTime(70_000);

    // 2 utterances, then big pause (well past 120s threshold).
    rt.recordUtterance('a');
    rt.recordUtterance('b');
    vi.advanceTimersByTime(60_000);
    rt.recordUtterance('c'); // bumps the timer back
    vi.advanceTimersByTime(DEFAULT_STEADY_CADENCE.pauseDebounceMs + 100);

    expect(fake.calls).toHaveLength(2);
    rt.dispose();
  });

  it('hard rate cap: rapid utterances don\'t fire more than once per 60s', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
    });

    // Get the first summary out the door.
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    fake.resolveNext();
    await vi.runOnlyPendingTimersAsync();
    expect(fake.calls).toHaveLength(1);

    // 30 utterances within 30 seconds — count threshold hits at 15,
    // but the rate cap (60s) should block the second fire.
    for (let i = 0; i < 30; i++) {
      rt.recordUtterance(`fast${String(i)}`);
      vi.advanceTimersByTime(1000);
    }
    // Walk pause-debounce out.
    vi.advanceTimersByTime(DEFAULT_STEADY_CADENCE.pauseDebounceMs + 100);

    // Rate cap was active for most of those 30 utterances.
    expect(fake.calls).toHaveLength(1);

    rt.dispose();
  });

  it('in-flight guard: a second trigger while the summarizer is in-flight is skipped', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });

    // First summary fires (cold-start count).
    for (let i = 0; i < 5; i++) rt.recordUtterance(`a${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    expect(fake.calls).toHaveLength(1);
    expect(fake.pendingCount()).toBe(1);

    // While in-flight, push more utterances + cross the debounce again.
    for (let i = 0; i < 5; i++) rt.recordUtterance(`b${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    // Should NOT have fired a second call.
    expect(fake.calls).toHaveLength(1);

    // Resolve. Now the next utterance should be eligible to fire (subject
    // to rate cap).
    fake.resolveNext();
    await vi.runOnlyPendingTimersAsync();

    rt.dispose();
  });
});

describe('MeetingSummarizerRuntime transcript handling', () => {
  it('appends utterances joined by newline and slides head when over the char cap', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
      transcriptCharCap: 20,
    });

    rt.recordUtterance('aaaaaaaaaaaaaaa'); // 15 chars
    rt.recordUtterance('bbbbbbbbbbbbbbb'); // joined becomes 31 chars > 20
    rt.recordUtterance('zzzz');           // joined becomes 36 chars > 20
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);

    expect(fake.calls).toHaveLength(1);
    const transcript = fake.calls[0]!.transcript_window;
    expect(transcript.length).toBeLessThanOrEqual(20);
    expect(transcript).toContain('zzzz');
    // The head ("aaaaaaaaaaaaaaa") should have been sliced off.
    expect(transcript).not.toContain('aaaaaaaaaaaaaaa');

    rt.dispose();
  });

  it('skips empty / whitespace utterances entirely', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
    });

    rt.recordUtterance('   ');
    rt.recordUtterance('');
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    expect(fake.calls).toHaveLength(0); // no transcript content, no fire

    rt.dispose();
  });
});

describe('MeetingSummarizerRuntime carry-forward + error handling', () => {
  it('passes the prior summary into the next summarize call', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
    });

    // First summary lands.
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    const first = makeSummary({
      summary: 'Discussed auth.',
      current_topic: 'auth flow',
      key_terms: ['Supabase'],
    });
    fake.resolveNext(first);
    await vi.runOnlyPendingTimersAsync();

    // Past rate cap, then enough utterances to fire again.
    vi.advanceTimersByTime(70_000);
    for (let i = 0; i < 15; i++) rt.recordUtterance(`later${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_STEADY_CADENCE.pauseDebounceMs + 100);
    expect(fake.calls).toHaveLength(2);

    const secondInput = fake.calls[1]!;
    expect(secondInput.prior_summary).toEqual(first);

    rt.dispose();
  });

  it('retains prior summary + bumps rate-cap clock on summarizer error', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const errors: unknown[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
      onSummarizerError: (e) => errors.push(e),
    });

    // First summary lands ok.
    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    const first = makeSummary({ summary: 'first' });
    fake.resolveNext(first);
    await vi.runOnlyPendingTimersAsync();
    expect(rt.getLastSummary()).toEqual(first);

    // Past rate cap, second fire — this one fails.
    vi.advanceTimersByTime(70_000);
    for (let i = 0; i < 15; i++) rt.recordUtterance(`x${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_STEADY_CADENCE.pauseDebounceMs + 100);
    expect(fake.calls).toHaveLength(2);
    fake.rejectNext(new Error('refused'));
    await vi.runOnlyPendingTimersAsync();

    // Prior summary unchanged; error surfaced via callback; no second
    // onSummaryUpdated event.
    expect(rt.getLastSummary()).toEqual(first);
    expect(updates).toHaveLength(1);
    expect(errors).toHaveLength(1);

    rt.dispose();
  });

  it('does NOT invoke onSummaryUpdated for in-flight calls that resolve after dispose', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });

    for (let i = 0; i < 5; i++) rt.recordUtterance(`u${String(i)}`);
    vi.advanceTimersByTime(DEFAULT_COLD_START_CADENCE.pauseDebounceMs + 100);
    expect(fake.pendingCount()).toBe(1);

    rt.dispose();
    fake.resolveNext(makeSummary());
    await vi.runOnlyPendingTimersAsync();

    expect(updates).toHaveLength(0);
    expect(rt.getLastSummary()).toBeNull();
  });

  it('dispose clears pending debounce timer; subsequent recordUtterance is a no-op', async () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
    });

    rt.recordUtterance('hello');
    rt.dispose();
    vi.advanceTimersByTime(60_000); // way past the cold-start debounce
    expect(fake.calls).toHaveLength(0);

    rt.recordUtterance('after-dispose');
    vi.advanceTimersByTime(60_000);
    expect(fake.calls).toHaveLength(0);
  });
});
