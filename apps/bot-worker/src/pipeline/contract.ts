// Shared, sink-agnostic retrieval/synthesis pipeline — the seam types (U1).
//
// The pipeline core (./core.ts) runs the ordered stages lifted from
// `maybeRetrieveAndEmit`: pre-retrieval relevance gate → embed → hybrid search
// → CRAG → dedup/parent-expand → emit cards → synthesize → citation-verify. It
// imports NO transport: every capability it needs (db access, embedding,
// synthesis, search/rerank/expand, classification) is injected via
// `PipelineDeps`, and every result it produces is written through a
// `PipelineSink`. Prod persists to Supabase + Realtime; the dev sidecar streams
// WS events; the eval collects scored intermediates. The core is unaware of
// which sink it's behind.
//
// KTD3 — gate placement is PRE-retrieval: a skipped utterance never pays for
//        embed + search and emits no cards.
// KTD4/R5 — trace is dev/eval-only via the OPTIONAL `recordTrace`: when it's
//           undefined the core does zero trace work (every trace block is
//           guarded by `if (sink.recordTrace)`).
// KTD6 — the sink is an interface: emitCard, synthesisStart/Delta/Done/Refusal,
//        recordMiss, recordSkip, and the optional recordTrace.

import type { VoyageEmbedder } from '@risezome/engine/embed';
import type { Synthesizer, CitationDetail } from '@risezome/engine/synthesize';
import type { MissRecord } from '@risezome/engine/gaps';
import type { RelevanceClassifier, RelevanceContext } from '@risezome/engine/relevance';
import type { Classifier } from '@risezome/engine/router';
import type { SkillRegistry, SkillResultKind, SkillResultItem } from '@risezome/engine/skills';
import type { Reranker } from '@risezome/engine/embed';
import type { QueryExpander } from '@risezome/engine/query-expand';
import type { MeetingSummary } from '@risezome/engine/summarize';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HybridHit } from '../corpus-search.js';
import type { WinningChunk } from '../parent-doc.js';

// ── Logger ──────────────────────────────────────────────────────────────

/** The structured logger shape the stages emit through (pino-compatible
 *  subset). Matches what `maybeRetrieveAndEmit` already takes. */
export interface PipelineLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

// ── Input (the source seam) ─────────────────────────────────────────────

/**
 * Everything the core needs about ONE utterance to run the pipeline. The
 * transcription source (Recall bot vs. local mic vs. golden question) is the
 * one thing that legitimately differs between callers — it's reduced to this
 * struct before the core runs.
 */
export interface PipelineInput {
  /** The latest finalized utterance — the text the relevance HEURISTIC and the
   *  LLM judge are applied to (the single most-recent utterance, never the
   *  rolling window — see classifyRelevanceHeuristic's caller contract). */
  readonly utteranceText: string;
  /** Stable id for the utterance, threaded onto cards/syntheses/misses. */
  readonly utteranceId: string;
  readonly meetingId: string;
  readonly orgId: string;
  /**
   * The text actually EMBEDDED and lexically searched. Prod passes the rolling
   * window; dev/eval pass the single utterance. A legitimate per-source
   * difference (KTD: it's part of the source seam, not the core), so the core
   * takes it verbatim rather than recomputing a window.
   */
  readonly queryText: string;
  /**
   * Optional pre-computed embedding of `queryText` (live-pipeline latency U1).
   * The question lane embeds the query text once for near-duplicate suppression
   * and passes that vector here so the core skips a redundant second embed. When
   * present, the core uses it verbatim instead of re-embedding; when absent (the
   * ambient lane, eval/legacy callers), the core embeds `queryText` itself. The
   * question lane applies no key-terms boost, so this vector equals what the core
   * would have produced.
   */
  readonly queryVector?: readonly number[];
  /**
   * Oldest-first prior context for the synthesizer (pronoun/fragment
   * resolution). Head entry is typically the rolling-summary prose; the
   * remainder are recent finals excluding the current utterance. Already
   * assembled by the caller from its own source state.
   */
  readonly recentContext?: readonly string[];
  /** Rolling-summary snapshot at call-fire time. Drives classifier context
   *  (current_topic + open_questions) and the env-gated key_terms boost. */
  readonly lastSummary?: MeetingSummary;
  /** Optional relevance context for the LLM judge, when a caller wants to
   *  override what's derived from `lastSummary`. */
  readonly relevanceContext?: RelevanceContext;
  /**
   * Triggering lane (live two-lane policy). `'question'` ⇒ this fire was a
   * detected substantive question; the core SKIPS its relevance gate and lets
   * the synthesizer be the relevance backstop (ground-or-refuse). `'ambient'`
   * (or undefined, for back-compat with eval/legacy callers) ⇒ the core runs
   * the relevance gate as before.
   */
  readonly lane?: 'question' | 'ambient';
}

// ── Deps (the injected capabilities) ────────────────────────────────────

/** Hybrid-search call, injected so the core never imports the Supabase
 *  binding directly. Mirrors `hybridSearch`'s shape minus the `db` (closed
 *  over by the dep). */
export type HybridSearchFn = (params: {
  readonly orgId: string;
  readonly queryVectorLiteral: string;
  readonly queryText: string;
  readonly limit: number;
  readonly reranker?: Reranker | undefined;
  readonly logger?: { warn: (obj: object, msg?: string) => void };
}) => Promise<HybridHit[]>;

/** True when the hit set is weak enough to warrant a CRAG expansion. */
export type IsLowConfidenceHitsFn = (hits: readonly HybridHit[]) => boolean;

/** Collapse same-doc hits to one survivor each (parent-doc dedup). */
export type DedupeByDocFn = <T>(
  items: readonly T[],
  docIdOf: (item: T) => string | undefined,
) => T[];

/** Expand each winning child chunk to its parent context, keyed by chunkId. */
export type ExpandWinnersToParentsFn = (
  orgId: string,
  winners: readonly WinningChunk[],
) => Promise<Map<string, string>>;

/**
 * The capabilities the core needs, injected so the core imports NO transport.
 * Search/rerank/expand fns are pre-bound to their db handle by the caller; the
 * core still gets `db` for the chunk/doc enrichment round-trips (the only raw
 * reads it does — a future engine-pure core would inject those rows too, KTD2).
 */
export interface PipelineDeps {
  readonly db: SupabaseClient;
  readonly embedder: VoyageEmbedder;
  /** Optional Anthropic synthesizer. When absent, the core stops after
   *  emitting cards (no synthesis stage). */
  readonly synthesizer?: Synthesizer;
  /** Optional LLM relevance judge. Used for `ambiguous`, and for
   *  `clearly_substantive` when `relevanceStrict` (U3). Absent ⇒ fail-open
   *  (the heuristic still short-circuits filler). */
  readonly relevanceClassifier?: RelevanceClassifier;
  /** Optional router classifier — paired with `skillRegistry` for the
   *  tool-dispatch stage. Absent (e.g. the eval) ⇒ the router stage is
   *  skipped cleanly. */
  readonly routerClassifier?: Classifier;
  /** Optional skill registry. Both this (non-empty) and `routerClassifier`
   *  must be present for the router stage to fire. */
  readonly skillRegistry?: SkillRegistry;

  // Search / CRAG seam (Supabase-bound fns, pre-closed over `db`).
  readonly hybridSearch: HybridSearchFn;
  readonly isLowConfidenceHits: IsLowConfidenceHitsFn;
  /** Cross-encoder reranker, or undefined when disabled. */
  readonly optionalReranker: () => Reranker | undefined;
  /** On-miss CRAG query expander, or undefined when disabled. */
  readonly optionalQueryExpander: () => QueryExpander | undefined;

  // Parent-doc seam.
  readonly dedupeByDoc: DedupeByDocFn;
  readonly expandWinnersToParents: ExpandWinnersToParentsFn;
  readonly parentDocEnabled: () => boolean;

  readonly logger: PipelineLogger;

  /** Skip confidence a classifier `skip` must clear to be honored (default
   *  0.7 — RELEVANCE_SKIP_THRESHOLD). */
  readonly relevanceSkipThreshold?: number;
  /** Strict "about-our-work" routing (U3): route `clearly_substantive`
   *  through the judge too, not just `ambiguous`. */
  readonly relevanceStrict?: boolean;
  /** Canonical top-K for hybrid search. The single canonical value (5 — see
   *  U1 resolution); a dep so a caller can still override. */
  readonly topK?: number;
}

// ── Sink (the output seam, KTD6) ────────────────────────────────────────

/** A card the core decided to surface — one per surviving deduped document. */
export interface PipelineCard {
  readonly docId: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  /** Truncated preview (≤400 chars). */
  readonly snippet: string;
  /** Full (possibly parent-expanded) chunk text — the highlight substrate. */
  readonly body: string;
  /** [0,1] similarity-ish score derived from cosine distance (0.5 for an
   *  FTS-only hit with no vector distance). */
  readonly score: number;
  /** 0-indexed rank within this retrieval batch. */
  readonly rank: number;
  /** Matched chunk is the doc's generated summary (U6). */
  readonly isSummary: boolean;
  readonly metadata: Record<string, unknown>;
  readonly utteranceId: string;
  readonly traceId: string;
  readonly url?: string;
  // ── Eval-only source intermediates (ignored by the supabase + ws sinks) ──
  // The eval collector rebuilds `EvalSourceView` / `RetrievedDoc` from these.
  // The prod card's `score` is the derived [0,1] similarity; the eval needs the
  // RAW fused RRF score + the lexical-match flag + the tight child excerpt the
  // synthesizer keyed on, none of which the card surface carries otherwise.
  /** Fused RRF score (higher = better) — what the eval reports as the source
   *  `score`, distinct from the card's derived [0,1] `score`. */
  readonly rrfScore?: number;
  /** Cosine distance for a vector candidate; null for an FTS-only hit. */
  readonly distance?: number | null;
  /** True when the chunk was a lexical (full-text-search) match. */
  readonly ftsMatched?: boolean;
  /** Chunk position within its doc. */
  readonly position?: number;
  /** The tight child excerpt that matched (U8 focus) — the synthesizer's
   *  per-source `focus`. */
  readonly focus?: string;
  /** The matched chunk id (the eval's `RetrievedDoc.chunkId`). */
  readonly chunkId?: string;
}

/** The card the sink persisted/echoed, plus the synthesis source it backs.
 *  The sink returns its assigned card id so the core can thread it into the
 *  synthesis's source-card list and citation mapping. */
export interface EmittedCard {
  /** The sink's identity for the surfaced card (e.g. `card_<uuid>`). The core
   *  treats it as an opaque token. */
  readonly cardId: string;
}

/** Start-of-synthesis signal (the source cards + the trace anchor). */
export interface SynthesisStartInfo {
  readonly synthesisId: string;
  readonly sourceCardIds: readonly string[];
  readonly traceId: string;
  readonly utteranceId: string;
}

/** A verified, card-resolved citation (the grounded-or-nothing survivors). */
export interface SynthesisCitation {
  readonly rank: number;
  readonly cardId: string;
  readonly position: number;
  readonly quote?: string;
}

/** Successful, grounded synthesis. */
export interface SynthesisDoneInfo {
  readonly synthesisId: string;
  readonly text: string;
  readonly citations: readonly SynthesisCitation[];
  readonly stopReason: string;
  readonly latencyMs: number;
  readonly utteranceId: string;
  // ── Eval-only intermediates (ignored by the supabase + ws sinks) ──
  /** The raw synthesizer output including the leading STATUS line (the eval's
   *  `rawSynthesis`). The card surface only needs the parsed body. */
  readonly rawSynthesis?: string;
  /** The FULL per-citation verification detail — including the `dropped` ones
   *  the grounded `citations` list excludes. The eval reports every status +
   *  the dropped/downgraded counts. */
  readonly citationDetails?: readonly CitationDetail[];
}

/** A refused or suppressed (ungrounded) synthesis. */
export interface SynthesisRefusalInfo {
  readonly synthesisId: string;
  /** 'refusal' = the model emitted no_relevant_context; 'ungrounded' = an
   *  answer with zero surviving citations (suppressed like a refusal). */
  readonly reason: 'refusal' | 'ungrounded';
  readonly latencyMs: number;
  readonly utteranceId: string;
  /** Per-run trace id. Refusals skip synthesisStart, so the supabase sink needs
   *  it here to satisfy syntheses.trace_id (NOT NULL) on the retracted row. */
  readonly traceId: string;
  // ── Eval-only intermediates (ignored by the supabase + ws sinks) ──
  /** Raw synthesizer output (with the STATUS line) — for an ungrounded answer
   *  this is the suppressed body; for a refusal it's the no_relevant_context
   *  output. */
  readonly rawSynthesis?: string;
  /** The parsed answer body (STATUS line stripped). Empty for a true refusal;
   *  the suppressed body for an ungrounded one. */
  readonly answer?: string;
  /** The model's refusal reason string, when it emitted no_relevant_context. */
  readonly refusalReason?: string | null;
  /** FULL per-citation verification detail (ungrounded case — every status). */
  readonly citationDetails?: readonly CitationDetail[];
}

/** A skip decision the gate made (no embed/search ran). */
export interface SkipInfo {
  readonly stage: 'heuristic-gate' | 'llm-judge';
  readonly reason: string;
  readonly confidence?: number;
}

/**
 * A raw tool/skill answer the router stage produced — the structured result of
 * an executed skill (e.g. `github_count`), surfaced INDEPENDENTLY of synthesis.
 * The tool result still rides into synthesis at source[0]; this is the standalone
 * "the skill answered" signal a dev surface renders as its own card so the raw
 * answer is always visible even when the synthesizer refuses. Mirrors
 * `SkillResult` (kind/summary/items) plus the skill name + args + trace anchors.
 */
export interface SkillResultInfo {
  readonly traceId: string;
  readonly utteranceId: string;
  readonly skillName: string;
  readonly args: Record<string, unknown>;
  readonly kind: SkillResultKind;
  readonly summary: string;
  readonly items: readonly SkillResultItem[];
}

/**
 * The output seam (KTD6). The core calls these at each emit point and never
 * imports a transport. `emitCard` returns the sink's card id so the core can
 * build the synthesis's source-card list. `recordTrace` is OPTIONAL — when a
 * sink omits it, the core does no trace work at all (R5).
 */
export interface PipelineSink {
  /** Surface one card. Returns the sink-assigned card id (for citation
   *  mapping). Prod persists + broadcasts; dev sends a WS event; eval collects.
   *  Returning `null` signals the sink dropped the card (e.g. a failed insert)
   *  — the core then skips it as a synthesis source. */
  emitCard(card: PipelineCard): Promise<EmittedCard | null>;
  synthesisStart(info: SynthesisStartInfo): void;
  /** Streamed token delta. The core may buffer and emit a single delta on
   *  grounded done (flash-fix) — the sink decides how to render. */
  synthesisDelta(synthesisId: string, delta: string): void;
  synthesisDone(info: SynthesisDoneInfo): void;
  synthesisRefusal(info: SynthesisRefusalInfo): void;
  recordMiss(miss: MissRecord): void;
  recordSkip(info: SkipInfo): void;
  /** OPTIONAL. Present ⇒ the core emits the raw executed-skill answer as a
   *  standalone signal (the dev page renders it as its own card, independent of
   *  synthesis). Absent (prod/eval) ⇒ the core skips it; the tool result still
   *  rides into synthesis at source[0] either way. Guarded with `?.` at the
   *  call site so a sink that omits it is unaffected. */
  recordSkillResult?(result: SkillResultInfo): void;
  /** OPTIONAL (KTD4/R5). Present ⇒ the core assembles + emits a per-stage
   *  trace; absent ⇒ the core does zero trace work. */
  recordTrace?(trace: PipelineTrace): void;
}

// ── Trace (dev/eval-only per-stage record, R6) ──────────────────────────

/** The ordered pipeline stages a trace record can describe. Subsumes the
 *  daemon's RetrievalTrace/relevanceSkip events and the eval's
 *  EvalQuestionView intermediates. */
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

/** Whether the stage ran to completion, was skipped (a prior condition meant
 *  it didn't apply), or short-circuited the whole pipeline (a stop). */
export type StageStatus = 'ran' | 'skipped' | 'short_circuited';

/**
 * One per-stage trace record. `decision`/`reason` carry the human-readable
 * "what happened and why"; `data` carries stage-specific structured detail
 * (hit count, scores, citation statuses). Only assembled when the sink defines
 * `recordTrace`.
 */
export interface StageRecord {
  readonly stage: PipelineStage;
  readonly status: StageStatus;
  /** The decision the stage reached (e.g. 'surface', 'skip', 'expanded'). */
  readonly decision?: string;
  /** Why — the explanation string surfaced on the dev panel. */
  readonly reason?: string;
  readonly latencyMs: number;
  /** Stage-specific structured payload (hit counts, scores, citation
   *  breakdown, …). */
  readonly data?: Record<string, unknown>;
}

/**
 * One ranked retrieved hit, carried INLINE on the `hybrid-search` stage's
 * `data.hits` so the trace is self-contained (a future persisted/after-the-fact
 * trace needs no separate `card` events to render the retrieved set). Built only
 * when tracing is on — zero-cost when no trace sink (it stays inside the
 * `trace !== null` guard in core.ts). Mirrors the card surface the panel renders.
 */
export interface TraceHit {
  /** 1-indexed rank within this retrieval batch (matches the `card` event). */
  readonly rank: number;
  readonly title: string;
  /** Derived [0,1] similarity (the card's `score`). */
  readonly score: number;
  /** Cosine distance for a vector candidate; null for an FTS-only hit. */
  readonly distance: number | null;
  /** True when the chunk was a lexical (full-text-search) match. */
  readonly ftsMatched: boolean;
  /** Matched chunk is the doc's generated summary (U6). */
  readonly isSummary: boolean;
}

/** The full per-utterance trace: one ordered list of stage records, anchored
 *  to the utterance + the retrieval trace id. */
export interface PipelineTrace {
  readonly traceId: string;
  readonly utteranceId: string;
  readonly meetingId: string;
  readonly stages: readonly StageRecord[];
}
