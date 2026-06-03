import { describe, expect, it } from 'vitest';
import { MeetingSummarizerRuntime, RESOLVED_ANSWERS_CAP } from '../src/summarizer-runtime.js';
import type { MeetingSummary, Summarizer, SummarizerInput } from '@risezome/engine/summarize';

function makeSummary(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return { summary: 'A summary.', current_topic: 'topic', open_questions: [], key_terms: [], ...overrides };
}

function makeFakeSummarizer(): {
  summarizer: Summarizer;
  calls: SummarizerInput[];
  resolveNext: (s?: MeetingSummary) => void;
  rejectNext: (e?: unknown) => void;
  pendingCount: () => number;
} {
  const calls: SummarizerInput[] = [];
  const pending: { resolve: (s: MeetingSummary) => void; reject: (e: unknown) => void }[] = [];
  const summarizer: Summarizer = {
    summarize: async (input: SummarizerInput) => {
      calls.push(input);
      return new Promise<MeetingSummary>((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return {
    summarizer,
    calls,
    resolveNext: (s) => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no pending summarize() call to resolve');
      next.resolve(s ?? makeSummary());
    },
    rejectNext: (e) => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no pending summarize() call to reject');
      next.reject(e ?? new Error('summarizer-error'));
    },
    pendingCount: () => pending.length,
  };
}

/** Let a resolved/rejected summarize() promise's .then callback run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MeetingSummarizerRuntime — demand-driven refresh', () => {
  it('does NOT summarize on utterances alone (no synthesis requested)', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    for (let i = 0; i < 20; i++) rt.recordUtterance(`u${String(i)}`);
    expect(fake.calls).toHaveLength(0); // the whole point: silent until asked
    rt.dispose();
  });

  it('refreshIfStale fires the first summary on a never-summarized runtime', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });
    rt.recordUtterance('what models do we use?');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(1);
    fake.resolveNext(makeSummary({ summary: 'first' }));
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.summary).toBe('first');
    rt.dispose();
  });

  it('refreshIfStale no-ops when there is no transcript yet', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(0);
    rt.dispose();
  });

  it('reuses a fresh summary, re-runs only once past the staleness window', async () => {
    let clock = 0;
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
      now: () => clock,
      refreshStalenessMs: 5_000,
    });

    rt.recordUtterance('q1');
    rt.refreshIfStale(); // never summarized → fires
    expect(fake.calls).toHaveLength(1);
    clock = 100;
    fake.resolveNext();
    await flush(); // lastSummaryAt = 100

    // 3s later — still fresh (< 5s), so a question does NOT re-run it.
    clock = 3_100;
    rt.recordUtterance('q2');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(1);

    // >5s since the summary landed — now stale, a question refreshes it.
    clock = 5_200;
    rt.recordUtterance('q3');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(2);
    rt.dispose();
  });

  it('in-flight guard: a refresh while one is in flight is skipped', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    rt.recordUtterance('q');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(1);
    expect(fake.pendingCount()).toBe(1);
    rt.refreshIfStale(); // in-flight → skipped
    expect(fake.calls).toHaveLength(1);
    rt.dispose();
  });

  it('carry-forward: passes the prior summary into the next summarize call', async () => {
    let clock = 0;
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
      now: () => clock,
      refreshStalenessMs: 1_000,
    });
    rt.recordUtterance('u');
    rt.refreshIfStale();
    const first = makeSummary({ summary: 'Discussed auth.', current_topic: 'auth flow', key_terms: ['Supabase'] });
    clock = 10;
    fake.resolveNext(first);
    await flush();

    clock = 2_000; // stale
    rt.recordUtterance('later');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.prior_summary).toEqual(first);
    rt.dispose();
  });

  it('error: retains prior summary, surfaces the error, stays fresh for the window', async () => {
    let clock = 0;
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const errors: unknown[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
      onSummarizerError: (e) => errors.push(e),
      now: () => clock,
      refreshStalenessMs: 1_000,
    });

    rt.recordUtterance('u');
    rt.refreshIfStale();
    const first = makeSummary({ summary: 'first' });
    clock = 10;
    fake.resolveNext(first);
    await flush();
    expect(rt.getLastSummary()).toEqual(first);

    clock = 2_000; // stale → fires, then fails
    rt.recordUtterance('x');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(2);
    fake.rejectNext(new Error('refused'));
    await flush();
    expect(rt.getLastSummary()).toEqual(first); // unchanged
    expect(updates).toHaveLength(1);
    expect(errors).toHaveLength(1);

    // lastSummaryAt bumped to 2000 on error → a question 500ms later is fresh.
    clock = 2_500;
    rt.recordUtterance('y');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(2);
    rt.dispose();
  });

  it('ignores an in-flight call that resolves after dispose', async () => {
    const fake = makeFakeSummarizer();
    const updates: MeetingSummary[] = [];
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: (s) => updates.push(s),
    });
    rt.recordUtterance('u');
    rt.refreshIfStale();
    expect(fake.pendingCount()).toBe(1);
    rt.dispose();
    fake.resolveNext(makeSummary());
    await flush();
    expect(updates).toHaveLength(0);
    expect(rt.getLastSummary()).toBeNull();
  });

  it('dispose makes recordUtterance + refreshIfStale no-ops', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    rt.recordUtterance('hello');
    rt.dispose();
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(0);
    rt.recordUtterance('after-dispose');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('MeetingSummarizerRuntime — close-the-loop answers', () => {
  it('recorded assistant answers ride into the summarize input', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    rt.recordAssistantAnswer('The project uses Claude Haiku, Voyage, and Deepgram.');
    rt.recordUtterance('q');
    rt.refreshIfStale();
    expect(fake.calls[0]!.resolved_answers).toEqual([
      'The project uses Claude Haiku, Voyage, and Deepgram.',
    ]);
    rt.dispose();
  });

  it('keeps only the most recent RESOLVED_ANSWERS_CAP answers', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    for (let i = 0; i < 12; i++) rt.recordAssistantAnswer(`answer ${String(i)}`);
    rt.recordUtterance('q');
    rt.refreshIfStale();
    const answers = fake.calls[0]!.resolved_answers;
    expect(answers).toHaveLength(RESOLVED_ANSWERS_CAP);
    expect(answers![0]).toBe('answer 4');
    expect(answers![7]).toBe('answer 11');
    rt.dispose();
  });

  it('omits resolved_answers entirely when none recorded', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    rt.recordUtterance('q');
    rt.refreshIfStale();
    expect(fake.calls[0]!.resolved_answers).toBeUndefined();
    rt.dispose();
  });
});

describe('MeetingSummarizerRuntime — transcript handling', () => {
  it('appends utterances joined by newline and slides the head over the char cap', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({
      summarizer: fake.summarizer,
      onSummaryUpdated: () => {},
      transcriptCharCap: 20,
    });
    rt.recordUtterance('aaaaaaaaaaaaaaa'); // 15
    rt.recordUtterance('bbbbbbbbbbbbbbb'); // joined > 20
    rt.recordUtterance('zzzz');
    rt.refreshIfStale();
    const transcript = fake.calls[0]!.transcript_window;
    expect(transcript.length).toBeLessThanOrEqual(20);
    expect(transcript).toContain('zzzz');
    expect(transcript).not.toContain('aaaaaaaaaaaaaaa');
    rt.dispose();
  });

  it('skips empty / whitespace utterances entirely', () => {
    const fake = makeFakeSummarizer();
    const rt = new MeetingSummarizerRuntime({ summarizer: fake.summarizer, onSummaryUpdated: () => {} });
    rt.recordUtterance('   ');
    rt.recordUtterance('');
    rt.refreshIfStale();
    expect(fake.calls).toHaveLength(0); // no transcript content, no fire
    rt.dispose();
  });
});
