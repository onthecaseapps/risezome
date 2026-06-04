'use client';

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

// ── Shapes mirrored from the bot-worker EvalQuestionView JSON ─────────────
type EvalBucket = 'relevant' | 'offtopic' | 'adjacent';
interface GoldenQuestion {
  q: string;
  bucket?: EvalBucket;
  must_surface?: string[];
  expect_answer_contains?: string[];
  expect_refusal?: boolean;
  note?: string;
}
interface SourceView {
  rank: number;
  docId: string;
  title: string;
  score: number;
  distance: number | null;
  ftsMatched: boolean;
  position: number;
  focus: string;
  text: string;
  isSummary: boolean;
}
type CitationStatus = 'verified' | 'downgraded' | 'dropped';
interface CitationView {
  rank: number;
  quote: string | null;
  status: CitationStatus;
}
interface QResult {
  q: string;
  recall: number | null;
  surfaced: string[];
  missed: string[];
  answer: string;
  isRefusal: boolean;
  answerContainsAll: boolean | null;
  pass: boolean;
}
interface Ragas {
  faithfulness: number;
  answerRelevancy: number;
  contextPrecision: number;
  contextRecall: number;
}
interface QuestionView {
  question: GoldenQuestion;
  result: QResult;
  sources: SourceView[];
  rawSynthesis: string;
  answer: string;
  isRefusal: boolean;
  suppressed: boolean;
  refusalReason: string | null;
  citations: CitationView[];
  droppedQuoted: number;
  downgradedToBare: number;
  ragas: Ragas | null;
  latencyMs?: number;
  gateSuppressed?: boolean;
}

type RunState = 'idle' | 'running' | QuestionView | { error: string };

function csvToArray(s: string): string[] | undefined {
  const arr = s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  return arr.length > 0 ? arr : undefined;
}

interface BucketAgg {
  total: number;
  surfaced: number;
  suppressed: number;
}
interface PrecisionAgg {
  precision: number | null;
  overRefusal: number | null;
  p50: number | null;
  p95: number | null;
  byBucket: Record<EvalBucket, BucketAgg>;
}

/** Precision / over-refusal / latency over completed views (mirrors the
 *  bot-worker summarizePrecision; null until at least one question has run). */
function aggregatePrecision(views: QuestionView[]): PrecisionAgg | null {
  if (views.length === 0) return null;
  const raw: Record<EvalBucket, { total: number; surfaced: number }> = {
    relevant: { total: 0, surfaced: 0 },
    offtopic: { total: 0, surfaced: 0 },
    adjacent: { total: 0, surfaced: 0 },
  };
  for (const v of views) {
    const b = v.question.bucket ?? 'relevant';
    raw[b].total += 1;
    if (!v.result.isRefusal) raw[b].surfaced += 1;
  }
  const surfacedTotal = raw.relevant.surfaced + raw.offtopic.surfaced + raw.adjacent.surfaced;
  const relevantTotal = raw.relevant.total;
  const lat = views
    .map((v) => v.latencyMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const pctl = (p: number): number | null =>
    lat.length > 0 ? (lat[Math.min(lat.length - 1, Math.max(0, Math.ceil((p / 100) * lat.length) - 1))] ?? null) : null;
  const mk = (x: { total: number; surfaced: number }): BucketAgg => ({
    total: x.total,
    surfaced: x.surfaced,
    suppressed: x.total - x.surfaced,
  });
  return {
    precision: surfacedTotal > 0 ? raw.relevant.surfaced / surfacedTotal : null,
    overRefusal: relevantTotal > 0 ? (relevantTotal - raw.relevant.surfaced) / relevantTotal : null,
    p50: pctl(50),
    p95: pctl(95),
    byBucket: { relevant: mk(raw.relevant), offtopic: mk(raw.offtopic), adjacent: mk(raw.adjacent) },
  };
}
function pctOrNa(n: number | null): string {
  return n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`;
}
function msOrNa(n: number | null): string {
  return n === null ? 'n/a' : `${n.toFixed(0)}ms`;
}

export function EvalDebugClient(): ReactElement {
  const [questions, setQuestions] = useState<GoldenQuestion[]>([]);
  const [results, setResults] = useState<Record<string, RunState>>({});
  const [metrics, setMetrics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadQuestions = useCallback(async () => {
    try {
      const res = await fetch('/api/debug/eval', { cache: 'no-store' });
      const json = (await res.json()) as { questions?: GoldenQuestion[]; error?: string };
      if (json.error !== undefined) setLoadError(json.error);
      else setQuestions(json.questions ?? []);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  const runOne = useCallback(
    async (question: GoldenQuestion): Promise<QuestionView | null> => {
      setResults((r) => ({ ...r, [question.q]: 'running' }));
      try {
        const res = await fetch('/api/debug/eval', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'run', question, metrics }),
        });
        const json = (await res.json()) as QuestionView | { error: string };
        if ('error' in json) {
          setResults((r) => ({ ...r, [question.q]: { error: json.error } }));
          return null;
        }
        setResults((r) => ({ ...r, [question.q]: json }));
        return json;
      } catch (e) {
        setResults((r) => ({ ...r, [question.q]: { error: String(e) } }));
        return null;
      }
    },
    [metrics],
  );

  const runAll = useCallback(async () => {
    setBusy(true);
    for (const q of questions) {
      await runOne(q);
    }
    setBusy(false);
  }, [questions, runOne]);

  // Aggregate pass/total over completed views.
  const completed = Object.values(results).filter((r): r is QuestionView => typeof r === 'object' && 'result' in r);
  const passed = completed.filter((v) => v.result.pass).length;
  const precision = aggregatePrecision(completed);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Corpus eval</h1>
        <span className="text-sm text-muted">
          {completed.length > 0 ? `${String(passed)}/${String(completed.length)} pass` : `${String(questions.length)} questions`}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={metrics} onChange={(e) => setMetrics(e.target.checked)} />
            RAGAS metrics (slower, paid)
          </label>
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={busy || questions.length === 0}
            className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Running…' : 'Run all'}
          </button>
        </div>
      </header>

      {precision !== null && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 rounded border border-border bg-card/40 px-4 py-2.5 text-sm">
          <span className="font-semibold">
            Precision <span className="text-emerald-400">{pctOrNa(precision.precision)}</span>
          </span>
          <span className="font-semibold">
            Over-refusal <span className="text-amber-400">{pctOrNa(precision.overRefusal)}</span>
          </span>
          <span className="text-muted">
            latency p50 {msOrNa(precision.p50)} / p95 {msOrNa(precision.p95)}
          </span>
          <span className="ml-auto text-xs text-muted">
            relevant {precision.byBucket.relevant.surfaced}/{precision.byBucket.relevant.total} surfaced ·
            offtopic {precision.byBucket.offtopic.suppressed}/{precision.byBucket.offtopic.total} suppressed ·
            adjacent {precision.byBucket.adjacent.suppressed}/{precision.byBucket.adjacent.total} suppressed
          </span>
        </div>
      )}

      {loadError !== null && (
        <p className="mb-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {loadError} — is the bot-worker running with LOCAL_DEBUG_ENABLED=true and BOT_WORKER_SECRET set?
        </p>
      )}

      <AddPromptForm onAdded={(qs) => setQuestions(qs)} />

      <ul className="mt-4 space-y-3">
        {questions.map((q) => (
          <QuestionCard
            key={q.q}
            question={q}
            state={results[q.q] ?? 'idle'}
            onRun={() => void runOne(q)}
          />
        ))}
      </ul>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'pass' | 'fail' | 'warn' | 'muted'; children: ReactNode }): ReactElement {
  const cls =
    tone === 'pass'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
      : tone === 'fail'
        ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
        : tone === 'warn'
          ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
          : 'bg-white/5 text-muted border-border';
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>{children}</span>;
}

function QuestionCard({
  question,
  state,
  onRun,
}: {
  question: GoldenQuestion;
  state: RunState;
  onRun: () => void;
}): ReactElement {
  const view = typeof state === 'object' && 'result' in state ? state : null;
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {view !== null && <Badge tone={view.result.pass ? 'pass' : 'fail'}>{view.result.pass ? 'pass' : 'fail'}</Badge>}
            {view?.suppressed === true && <Badge tone="warn">suppressed</Badge>}
            {view?.isRefusal === true && !view.suppressed && <Badge tone="muted">refusal</Badge>}
            <span className="font-medium">{question.q}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
            {question.expect_answer_contains !== undefined && (
              <span>expect: {question.expect_answer_contains.join(', ')}</span>
            )}
            {question.expect_refusal === true && <span>expect: refusal</span>}
            {question.must_surface !== undefined && <span>surface: {question.must_surface.join(', ')}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={state === 'running'}
          className="shrink-0 rounded border border-border px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-50"
        >
          {state === 'running' ? 'Running…' : 'Run'}
        </button>
      </div>

      {typeof state === 'object' && 'error' in state && (
        <p className="mt-2 text-sm text-rose-300">Error: {state.error}</p>
      )}

      {view !== null && <ViewBody view={view} />}
    </li>
  );
}

function ViewBody({ view }: { view: QuestionView }): ReactElement {
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
      {/* Answer */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted">Synthesis</div>
        {view.answer.length > 0 ? (
          <p className="mt-1 whitespace-pre-wrap">{view.answer}</p>
        ) : (
          <p className="mt-1 italic text-muted">
            {view.suppressed
              ? 'Suppressed (no citation survived verification) — hidden in production.'
              : `Refused${view.refusalReason !== null ? `: ${view.refusalReason}` : ''}`}
          </p>
        )}
        {view.result.answerContainsAll === false && (
          <p className="mt-1 text-xs text-rose-300">answer missing an expected substring</p>
        )}
      </div>

      {/* Citations */}
      {view.citations.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Citations · {String(view.downgradedToBare)} downgraded · {String(view.droppedQuoted)} dropped
          </div>
          <ul className="mt-1 space-y-1">
            {view.citations.map((c, i) => (
              <li key={`${String(c.rank)}-${String(i)}`} className="flex items-start gap-2 text-xs">
                <Badge
                  tone={c.status === 'verified' ? 'pass' : c.status === 'downgraded' ? 'warn' : 'fail'}
                >
                  [{String(c.rank)}] {c.status}
                </Badge>
                {c.quote !== null && <span className="text-muted">“{c.quote}”</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* RAGAS */}
      {view.ragas !== null && (
        <div className="flex flex-wrap gap-x-4 text-xs text-muted">
          <span>faithfulness {view.ragas.faithfulness.toFixed(2)}</span>
          <span>relevancy {view.ragas.answerRelevancy.toFixed(2)}</span>
          <span>ctx-precision {view.ragas.contextPrecision.toFixed(2)}</span>
          <span>ctx-recall {view.ragas.contextRecall.toFixed(2)}</span>
        </div>
      )}

      {/* Sources */}
      <details>
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted">
          Retrieved sources ({String(view.sources.length)})
        </summary>
        <ul className="mt-2 space-y-2">
          {view.sources.map((s) => (
            <li key={`${String(s.rank)}-${s.docId}`} className="rounded border border-border bg-black/20 p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-accent">[{String(s.rank)}]</span>
                <span className="font-medium">{s.title}</span>
                {s.isSummary && (
                  <span className="rounded border border-accent/40 bg-accent/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-accent">
                    summary
                  </span>
                )}
                <span className="text-muted">
                  score {s.score.toFixed(3)}
                  {s.distance !== null ? ` · dist ${s.distance.toFixed(3)}` : ''}
                  {s.ftsMatched ? ' · fts' : ''} · pos {String(s.position)}
                </span>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted">
                  matched excerpt + context ({String(s.text.length)} chars)
                </summary>
                <div className="mt-1 text-xs">
                  <div className="text-[10px] uppercase tracking-wider text-muted">matched excerpt</div>
                  <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-amber-200/90">{s.focus}</pre>
                  {s.text !== s.focus && (
                    <>
                      <div className="mt-1.5 text-[10px] uppercase tracking-wider text-muted">expanded context</div>
                      <pre className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{s.text}</pre>
                    </>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function AddPromptForm({ onAdded }: { onAdded: (qs: GoldenQuestion[]) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [expect, setExpect] = useState('');
  const [surface, setSurface] = useState('');
  const [refusal, setRefusal] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (q.trim().length === 0) {
      setError('question text is required');
      return;
    }
    setSaving(true);
    setError(null);
    const expectArr = csvToArray(expect);
    const surfaceArr = csvToArray(surface);
    const question: GoldenQuestion = {
      q: q.trim(),
      ...(expectArr !== undefined ? { expect_answer_contains: expectArr } : {}),
      ...(surfaceArr !== undefined ? { must_surface: surfaceArr } : {}),
      ...(refusal ? { expect_refusal: true } : {}),
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
    };
    try {
      const res = await fetch('/api/debug/eval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add', question }),
      });
      const json = (await res.json()) as { ok?: boolean; questions?: GoldenQuestion[]; error?: string };
      if (json.error !== undefined) {
        setError(json.error);
      } else {
        onAdded(json.questions ?? []);
        setQ('');
        setExpect('');
        setSurface('');
        setRefusal(false);
        setNote('');
        setOpen(false);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [q, expect, surface, refusal, note, onAdded]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-border px-3 py-1.5 text-sm hover:bg-white/5"
      >
        + Add prompt
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="grid gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Question (as a participant would phrase it)"
          className="rounded border border-border bg-black/20 px-2 py-1.5 text-sm"
        />
        <input
          value={expect}
          onChange={(e) => setExpect(e.target.value)}
          placeholder="expect_answer_contains (comma-separated, ground-truth terms)"
          className="rounded border border-border bg-black/20 px-2 py-1.5 text-sm"
        />
        <input
          value={surface}
          onChange={(e) => setSurface(e.target.value)}
          placeholder="must_surface (comma-separated doc/title hints, informational)"
          className="rounded border border-border bg-black/20 px-2 py-1.5 text-sm"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note (optional)"
          className="rounded border border-border bg-black/20 px-2 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={refusal} onChange={(e) => setRefusal(e.target.checked)} />
          expect refusal (off-topic; the corpus should decline)
        </label>
        {error !== null && <p className="text-xs text-rose-300">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save prompt'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
