/**
 * Pipeline-trace model for the local-mic debug page (Pipeline Trace Debug, U2).
 *
 * Pure, React-free transforms that turn a live `UtteranceTrace` (the WS `trace`
 * event the bot-worker emits per finalized utterance — see
 * apps/bot-worker/src/pipeline/{contract,core,sink-ws}.ts) into everything the
 * UI renders: the ordered display ledger, the terminal outcome, the suppression
 * -gate ribbon, the latency waterfall, and per-stage detail rows.
 *
 * The bot-worker is the source of truth for WHAT ran (the StageRecord[]); this
 * catalog is the source of truth for DISPLAY (order, codes, names, ribbon
 * membership, deep-links). A catalog row with no matching trace record renders
 * as "not reached" when downstream of a terminal stop.
 *
 * KTD3: the two real relevance stages (`heuristic-gate` + `llm-judge`) merge
 * into ONE "Relevance" display row whose detail grid carries both decisions.
 * KTD4: the portal keeps its own copy of the wire types (no cross-package
 * import); this module owns them and `_trace-panel.tsx` re-exports for callers.
 */

// ── Wire types (mirrored from apps/bot-worker/src/pipeline/contract.ts) ──────

/** The ordered pipeline stages a trace record can describe. Extended in U1 with
 *  the previously-implicit stages so the dev ledger is faithful to runPipeline. */
export type PipelineStage =
  | 'empty-query'
  | 'heuristic-gate'
  | 'llm-judge'
  | 'router'
  | 'embed'
  | 'hybrid-search'
  | 'crag'
  | 'no-hits'
  | 'dedup-expand'
  | 'emit'
  | 'skill'
  | 'synthesis'
  | 'refusal-gate'
  | 'citation-verify'
  | 'reveal';

export type StageStatus = 'ran' | 'skipped' | 'short_circuited';

/** One ranked retrieved hit carried INLINE on the hybrid-search stage's
 *  `data.hits` (mirrors the bot-worker `TraceHit`). */
export interface TraceHit {
  rank: number;
  title: string;
  score: number;
  distance: number | null;
  ftsMatched: boolean;
  isSummary: boolean;
}

export interface StageRecord {
  stage: PipelineStage;
  status: StageStatus;
  /** The decision the stage reached (e.g. 'surface', 'skip', 'answer'). */
  decision?: string;
  /** Why — the explanation string surfaced on this panel. */
  reason?: string;
  latencyMs: number;
  /** Stage-specific structured payload (hits, counts, citation breakdown). */
  data?: Record<string, unknown>;
}

/** The `trace` WS event payload (the PipelineTrace, plus the `type` tag). */
export interface TraceEvent {
  type: 'trace';
  traceId: string;
  utteranceId: string;
  meetingId: string;
  stages: StageRecord[];
}

/** What the client stores per utterance (the trace minus the `type` tag). */
export interface UtteranceTrace {
  traceId: string;
  utteranceId: string;
  meetingId: string;
  stages: StageRecord[];
}

// ── Trace indexing (testable, transport-free) ──────────────────────────────

/**
 * Fold a `trace` event into the per-utterance index. Pure + immutable: a `trace`
 * event is stored under its `utteranceId`; a later trace for the same utterance
 * replaces the prior one (the latest run wins — utterances are re-traced on
 * revision).
 */
export function indexTrace(
  prev: Map<string, UtteranceTrace>,
  evt: TraceEvent,
): Map<string, UtteranceTrace> {
  const next = new Map(prev);
  next.set(evt.utteranceId, {
    traceId: evt.traceId,
    utteranceId: evt.utteranceId,
    meetingId: evt.meetingId,
    stages: evt.stages,
  });
  return next;
}

// ── Display palette (matches the design bundle; diagnostic surface) ─────────

export type DisplayStatus = 'pass' | 'skip' | 'miss' | 'failopen' | 'notreached' | 'info';

/** Hex colors used for the dynamic bits (waterfall segments, node borders,
 *  ribbon chips) where a per-status color can't be a static Tailwind class. */
export const STATUS_COLORS: Record<DisplayStatus, string> = {
  pass: '#46c08a', // proceeded
  skip: '#e6a23c', // gated (recordSkip)
  miss: '#f0616d', // recordMiss (no_hits / refusal / ungrounded)
  failopen: '#4d8df6', // error/timeout but proceeded (CRAG fired, didn't adopt)
  notreached: '#4a4b57', // downstream of a stop
  info: '#6b6b73', // portal-derived informational rows (threshold/cooldown)
};

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  pass: 'PASS',
  skip: 'SKIP',
  miss: 'MISS',
  failopen: 'FAIL-OPEN',
  notreached: '—',
  info: 'N/A',
};

// ── Canonical display catalog (the 16-row ledger) ───────────────────────────

/** A ledger row id — the wire stages plus the portal-derived PRE rows and the
 *  merged `relevance` display row (KTD3). */
export type LedgerRowId =
  | 'threshold'
  | 'cooldown'
  | 'empty-query'
  | 'relevance'
  | 'router'
  | 'embed'
  | 'hybrid-search'
  | 'crag'
  | 'no-hits'
  | 'dedup-expand'
  | 'emit'
  | 'skill'
  | 'synthesis'
  | 'refusal-gate'
  | 'citation-verify'
  | 'reveal';

export interface CatalogRow {
  id: LedgerRowId;
  code: string; // 'PRE' | 'S04'..'S17'
  name: string;
  engine: string;
  /** Portal-derived (not from the trace) — threshold/cooldown aren't gated in
   *  the dev path, so they render as informational "not gated in dev" rows. */
  derived?: boolean;
  /** When set, this display row is built by merging these wire stages (KTD3). */
  mergeFrom?: PipelineStage[];
  /** Deep-link target for the Outputs panel. */
  outputsLink?: 'retrievals' | 'synthesis';
}

export const STAGE_CATALOG: readonly CatalogRow[] = [
  { id: 'threshold', code: 'PRE', name: 'Utterance gate', engine: 'min-length · finality threshold', derived: true },
  { id: 'cooldown', code: 'PRE', name: 'Cooldown', engine: 'per-doc emit cooldown', derived: true },
  { id: 'empty-query', code: 'S04', name: 'Empty-query gate', engine: 'trimmed length check' },
  { id: 'relevance', code: 'S05', name: 'Relevance gate', engine: 'KTD3 · heuristic → Haiku judge', mergeFrom: ['heuristic-gate', 'llm-judge'] },
  { id: 'router', code: 'S06', name: 'Router (parallel)', engine: 'intent classifier · skill registry' },
  { id: 'embed', code: 'S07', name: 'Embed', engine: 'Voyage · voyage-3-large' },
  { id: 'hybrid-search', code: 'S08', name: 'Hybrid search', engine: 'pgvector + FTS · RRF · reranker', outputsLink: 'retrievals' },
  { id: 'crag', code: 'S09', name: 'CRAG expansion', engine: 'Claude term augmentation', outputsLink: 'retrievals' },
  { id: 'no-hits', code: 'S10', name: 'No-hits gate', engine: 'miss → knowledge gap' },
  { id: 'dedup-expand', code: 'S11', name: 'Enrichment', engine: 'dedupeByDoc · parent-expand · org-scoped' },
  { id: 'emit', code: 'S12', name: 'Emit cards', engine: 'sink.emitCard · stale retraction', outputsLink: 'retrievals' },
  { id: 'skill', code: 'S13', name: 'Router collect + skill', engine: 'await router · safety-net' },
  { id: 'synthesis', code: 'S14', name: 'Synthesis', engine: 'Claude Haiku · ≤150 tok · buffered', outputsLink: 'synthesis' },
  { id: 'refusal-gate', code: 'S15', name: 'Refusal gate', engine: 'STATUS: no_relevant_context', outputsLink: 'synthesis' },
  { id: 'citation-verify', code: 'S16', name: 'Citation verify', engine: 'quote-verify · grounded-or-nothing', outputsLink: 'synthesis' },
  { id: 'reveal', code: 'S17', name: 'Reveal', engine: 'stream · encrypt (org KMS) · persist', outputsLink: 'synthesis' },
];

// ── Ledger ──────────────────────────────────────────────────────────────────

export interface LedgerRow extends CatalogRow {
  status: DisplayStatus;
  latencyMs: number | null;
  result: string;
  detail: [string, string][];
  /** The underlying wire record(s) — for the JSON tab + debugging. */
  records: StageRecord[];
}

/** Map a single wire record to a display status (pre-stop-propagation). */
function statusOf(rec: StageRecord): DisplayStatus {
  if (rec.status === 'short_circuited') {
    // A relevance/heuristic stop is a skip; a no-hits/refusal stop is a miss.
    if (rec.stage === 'heuristic-gate' || rec.stage === 'llm-judge' || rec.stage === 'empty-query') {
      return 'skip';
    }
    return 'miss';
  }
  if (rec.stage === 'crag') {
    // CRAG that actually fired (on a miss/weak pass) but didn't change the
    // outcome reads as fail-open; a confident/skipped CRAG is a pass.
    const fired = rec.reason === 'miss' || rec.reason === 'low_confidence';
    return rec.status === 'ran' && fired ? 'failopen' : 'pass';
  }
  if (rec.stage === 'citation-verify' && rec.decision === 'ungrounded') return 'miss';
  if (rec.status === 'skipped') return 'notreached';
  return 'pass';
}

/** Is this display status a terminal stop (everything after it is not reached)? */
function isStop(status: DisplayStatus): boolean {
  return status === 'skip' || status === 'miss';
}

/** Build the ordered display ledger from a trace. Joins each catalog row to its
 *  wire record(s), merges the relevance pair (KTD3), computes display status,
 *  and marks every row past the terminal stop as "not reached". */
export function buildLedger(trace: UtteranceTrace | null): LedgerRow[] {
  const byStage = new Map<PipelineStage, StageRecord>();
  if (trace) for (const rec of trace.stages) byStage.set(rec.stage, rec);

  let stopped = false;
  return STAGE_CATALOG.map((cat): LedgerRow => {
    if (cat.derived) {
      // Portal-derived PRE rows: not gated in the dev path (R9).
      return {
        ...cat,
        status: 'info',
        latencyMs: null,
        result: 'not gated in dev — runs in the prod adapter only',
        detail: [['applies', 'prod Recall path only'], ['dev', 'runPipeline called directly — no throttle']],
        records: [],
      };
    }

    const records = cat.mergeFrom
      ? cat.mergeFrom.flatMap((s) => (byStage.has(s) ? [byStage.get(s)!] : []))
      : byStage.has(cat.id as PipelineStage)
        ? [byStage.get(cat.id as PipelineStage)!]
        : [];

    if (records.length === 0) {
      // No record for this stage. If we're past a stop it never ran; otherwise
      // it was a skipped/not-applicable stage on this path.
      return { ...cat, status: 'notreached', latencyMs: null, result: stopped ? 'not reached' : '—', detail: [], records: [] };
    }

    // Display status: for a merged row, the most "advanced" sub-status wins
    // (a judge skip dominates a heuristic pass).
    const subStatuses = records.map(statusOf);
    const status: DisplayStatus = stopped
      ? 'notreached'
      : (subStatuses.find(isStop) ?? subStatuses.find((s) => s === 'failopen') ?? subStatuses[0] ?? 'pass');

    const latencyMs = records.reduce((a, r) => a + r.latencyMs, 0);
    const result = resultLine(cat.id, records);
    const detail = records.flatMap(stageDetailRows);

    if (!stopped && isStop(status)) stopped = true;
    return { ...cat, status, latencyMs, result, detail, records };
  });
}

export function reachedCount(ledger: LedgerRow[]): number {
  return ledger.filter((r) => r.status !== 'notreached').length;
}

// ── Outcome ─────────────────────────────────────────────────────────────────

export type OutcomeType = 'grounded' | 'miss' | 'skip' | 'ungrounded' | 'refusal' | 'pending';

export interface Outcome {
  type: OutcomeType;
  headline: string;
  sub: string;
  ms: number;
  gap: boolean;
}

const OUTCOME_HEADLINE: Record<OutcomeType, string> = {
  grounded: 'Grounded answer revealed',
  miss: 'Miss — no usable hits',
  skip: 'Skipped — relevance gate',
  ungrounded: 'Ungrounded — answer suppressed',
  refusal: 'Refused — no relevant context',
  pending: 'In flight',
};

/** Classify the terminal outcome of a trace, mirroring the design's outcome
 *  banner. Reads the most-downstream meaningful stage. */
export function deriveOutcome(trace: UtteranceTrace | null): Outcome {
  const byStage = new Map<PipelineStage, StageRecord>();
  if (trace) for (const rec of trace.stages) byStage.set(rec.stage, rec);
  const ms = trace ? trace.stages.reduce((a, s) => a + s.latencyMs, 0) : 0;

  const has = (s: PipelineStage): StageRecord | undefined => byStage.get(s);
  let type: OutcomeType = 'pending';
  let sub = '';

  if (has('reveal')?.status === 'ran') {
    type = 'grounded';
    const cites = numberFrom(has('reveal')?.data, 'citations');
    const cards = numberFrom(has('emit')?.data, 'cards');
    sub = `${cards ?? '—'} cards · ${cites ?? 0} citations verified`;
  } else if (has('citation-verify')?.decision === 'ungrounded') {
    type = 'ungrounded';
    const total = numberFrom(has('citation-verify')?.data, 'total') ?? 0;
    sub = `0 / ${total} citations verified · grounded-or-nothing`;
  } else if (has('refusal-gate')?.status === 'short_circuited') {
    type = 'refusal';
    sub = 'STATUS: no_relevant_context';
  } else if (has('no-hits')?.status === 'short_circuited') {
    type = 'miss';
    const gap = boolFrom(has('no-hits')?.data, 'recordedGap');
    sub = gap ? 'recorded as knowledge gap · 0 cards' : 'filler — not a gap · 0 cards';
  } else if (has('llm-judge')?.status === 'short_circuited') {
    type = 'skip';
    sub = `judge skip · conf ${numberFrom(has('llm-judge')?.data, 'confidence') ?? '—'}`;
  } else if (has('heuristic-gate')?.status === 'short_circuited') {
    type = 'skip';
    sub = 'heuristic filler · 0 LLM calls · zero cost';
  } else if (has('empty-query')?.status === 'short_circuited') {
    type = 'skip';
    sub = 'empty query';
  } else if (has('emit')?.status === 'ran') {
    // Reached emit but no reveal/miss yet — synthesis still in flight or absent.
    type = 'grounded';
    sub = `${numberFrom(has('emit')?.data, 'cards') ?? '—'} cards`;
  }

  return {
    type,
    headline: OUTCOME_HEADLINE[type],
    sub,
    ms,
    gap: type === 'miss' && boolFrom(has('no-hits')?.data, 'recordedGap'),
  };
}

// ── Suppression-gate ribbon ─────────────────────────────────────────────────

export interface RibbonSegment {
  id: LedgerRowId;
  label: string;
  status: DisplayStatus;
}

const RIBBON: { id: LedgerRowId; label: string }[] = [
  { id: 'threshold', label: 'threshold' },
  { id: 'cooldown', label: 'cooldown' },
  { id: 'empty-query', label: 'empty' },
  { id: 'relevance', label: 'relevance' },
  { id: 'hybrid-search', label: 'floor' },
  { id: 'crag', label: 'CRAG' },
  { id: 'no-hits', label: 'no-hits' },
  { id: 'refusal-gate', label: 'refusal' },
  { id: 'citation-verify', label: 'citations' },
];

/** The one-line suppression chain, colored to show where the utterance died. */
export function gateRibbon(ledger: LedgerRow[]): RibbonSegment[] {
  const byId = new Map(ledger.map((r) => [r.id, r]));
  return RIBBON.map((g) => ({ id: g.id, label: g.label, status: byId.get(g.id)?.status ?? 'notreached' }));
}

// ── Latency waterfall ───────────────────────────────────────────────────────

export interface WaterfallSegment {
  id: LedgerRowId;
  name: string;
  ms: number;
  pct: number;
  status: DisplayStatus;
  /** Show a labeled legend entry (only for non-trivial stages). */
  labeled: boolean;
}

const WATERFALL_LABEL_FLOOR_MS = 30;

/** Proportional, per-stage colored segments of the end-to-end latency. */
export function waterfallSegments(ledger: LedgerRow[]): WaterfallSegment[] {
  const timed = ledger.filter((r) => r.latencyMs != null && r.latencyMs > 0);
  const sum = timed.reduce((a, r) => a + (r.latencyMs ?? 0), 0) || 1;
  return timed.map((r) => {
    const ms = r.latencyMs ?? 0;
    return { id: r.id, name: r.name, ms, pct: (ms / sum) * 100, status: r.status, labeled: ms >= WATERFALL_LABEL_FLOOR_MS };
  });
}

// ── Per-stage detail rows ───────────────────────────────────────────────────

/** Flatten a wire record's decision/reason/data into displayable key/value
 *  pairs for the expandable detail grid. */
export function stageDetailRows(rec: StageRecord): [string, string][] {
  const rows: [string, string][] = [];
  if (rec.decision !== undefined) rows.push(['decision', rec.decision]);
  if (rec.reason !== undefined) rows.push(['reason', rec.reason]);
  const data = rec.data;
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'hits' && Array.isArray(v)) {
        rows.push(['hits', `${v.length} ranked`]);
        continue;
      }
      rows.push([k, formatValue(v)]);
    }
  }
  return rows;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resultLine(id: LedgerRowId, records: StageRecord[]): string {
  // Prefer an explicit reason; else compose from decision + key data.
  const first = records[0];
  if (!first) return '—';
  if (id === 'relevance') {
    const heur = records.find((r) => r.stage === 'heuristic-gate');
    const judge = records.find((r) => r.stage === 'llm-judge');
    const parts = [heur ? `heuristic: ${heur.decision ?? heur.reason ?? 'ran'}` : null,
      judge ? `judge: ${judge.decision ?? 'skipped'}` : null].filter(Boolean);
    return parts.join(' · ') || 'ran';
  }
  if (first.reason) return first.reason;
  if (first.decision) return first.decision;
  return 'ran';
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `${v.length} items`;
  return JSON.stringify(v);
}

function numberFrom(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = data?.[key];
  return typeof v === 'number' ? v : undefined;
}

function boolFrom(data: Record<string, unknown> | undefined, key: string): boolean {
  return data?.[key] === true;
}
