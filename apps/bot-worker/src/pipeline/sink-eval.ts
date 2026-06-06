// Eval `PipelineSink` — an in-memory collector that rebuilds the rich
// `EvalQuestionView` intermediates the corpus eval scores against (U4).
//
// This is the eval half of the source-in/sink-out seam: the shared core
// (./core.ts) runs the SAME stages prod + dev run, transport-free, and routes
// every result through a `PipelineSink`. Where the supabase sink persists and
// the ws sink broadcasts, this sink simply ACCUMULATES into memory — it emits
// nothing. `evaluateQuestion` (corpus-eval.ts) then reads the collected state
// to assemble an `EvalQuestionView` and run the existing scorer.
//
// Faithfulness is the whole point of U4: the consolidated core must reproduce
// the EXACT surface/suppress + sources + synthesis result the old hand-mirrored
// `evaluateQuestion` produced, so the corpus eval still measures 99% precision /
// 1% over-refusal. This collector therefore mirrors those intermediates field-
// for-field:
//
//   emitCard         → one `EvalSourceView` + one `RetrievedDoc` (the source the
//                      synthesizer saw, plus the RRF score recall keys on). The
//                      core emits one card per surviving deduped doc, in rank
//                      order — the same list the old eval built from `sourceHits`.
//   synthesisDone    → grounded answer + rawSynthesis + FULL citation detail.
//   synthesisRefusal → refusal ('refusal') OR suppressed/ungrounded
//                      ('ungrounded') that never streamed, with rawSynthesis +
//                      citation detail.
//   synthesisRetract → a streamed-then-ungrounded answer pulled at the gate;
//                      scored identically to synthesisRefusal (did not stand).
//   recordMiss       → captured (drives the no-hits / refusal reason string).
//   recordSkip       → the gate short-circuit signal: `gateSuppressed = true`
//                      ONLY when this fired (heuristic-gate / llm-judge), exactly
//                      matching the old eval's precision semantics.
//   recordTrace      → the `PipelineTrace` carried onto the view (like the dev
//                      sink — the eval ships trace ON).
//
// recordTrace is DEFINED here, so the core assembles + emits a per-stage trace
// (the eval ships the trace on the view; prod omits recordTrace and runs
// trace-free — KTD4/R5).

import type { MissRecord } from '@risezome/engine/gaps';
import type { CitationDetail } from '@risezome/engine/synthesize';
import type {
  PipelineSink,
  PipelineCard,
  EmittedCard,
  SynthesisStartInfo,
  SynthesisDoneInfo,
  SynthesisRefusalInfo,
  SynthesisRetractInfo,
  SkipInfo,
  PipelineTrace,
} from './contract.js';

/** A source exactly as the synthesizer saw it, plus retrieval scores. Mirrors
 *  corpus-eval's `EvalSourceView` so the collector hands it back verbatim. */
export interface CollectedSource {
  readonly rank: number;
  readonly chunkId: string;
  readonly docId: string;
  readonly title: string;
  readonly score: number;
  readonly distance: number | null;
  readonly ftsMatched: boolean;
  readonly position: number;
  readonly focus: string;
  readonly text: string;
  readonly isSummary: boolean;
}

/** The terminal synthesis outcome the core decided. `kind`:
 *  - 'done'       → grounded answer (text + citations survived verification).
 *  - 'refusal'    → the model emitted no_relevant_context.
 *  - 'ungrounded' → an answer whose citations all failed → suppressed. */
export interface CollectedSynthesis {
  readonly kind: 'done' | 'refusal' | 'ungrounded';
  readonly rawSynthesis: string;
  readonly answer: string;
  readonly refusalReason: string | null;
  readonly citationDetails: readonly CitationDetail[];
}

/**
 * The in-memory eval sink. Build one per `evaluateQuestion` call, pass it to
 * `runPipeline`, then read the collected state. It never emits — every method
 * just records. The synthesis methods are mutually exclusive per run (the core
 * calls synthesisStart→Delta→Done for a grounded answer, or synthesisRefusal
 * alone for a refused/ungrounded one), so `synthesis` holds the single outcome.
 */
export class EvalCollectorSink implements PipelineSink {
  /** Surfaced sources in rank order (one per surviving deduped doc). */
  readonly sources: CollectedSource[] = [];
  /** The terminal synthesis outcome, or null when synthesis never ran (gate
   *  skip / no hits / embed fail). */
  synthesis: CollectedSynthesis | null = null;
  /** Misses recorded (no_hits / refusal / ungrounded) — drives reason strings. */
  readonly misses: MissRecord[] = [];
  /** The gate short-circuit, when one fired BEFORE retrieval. Its presence is
   *  the exact `gateSuppressed` signal. */
  skip: SkipInfo | null = null;
  /** The per-utterance trace (the eval ships it on the view). */
  trace: PipelineTrace | null = null;

  emitCard(card: PipelineCard): Promise<EmittedCard | null> {
    // The core assigns the card's eval source fields (rrfScore/ftsMatched/focus/
    // position) additively; rebuild the source view the synthesizer keyed on.
    this.sources.push({
      // The card's `rank` is 0-indexed; the eval source view is 1-indexed.
      rank: card.rank + 1,
      chunkId: card.chunkId ?? '',
      docId: card.docId,
      title: card.title,
      // The eval `score` is the RAW fused RRF score, not the card's derived
      // [0,1] similarity (`card.score`).
      score: card.rrfScore ?? card.score,
      distance: card.distance ?? null,
      ftsMatched: card.ftsMatched ?? false,
      position: card.position ?? 0,
      focus: card.focus ?? '',
      // `body` is the (possibly parent-expanded) text the synthesizer formulated
      // from — the eval's source `text`.
      text: card.body,
      isSummary: card.isSummary,
    });
    // A unique, stable opaque id so synthesis citations resolve back to a
    // source; the eval never persists it.
    return Promise.resolve({ cardId: `eval_${card.utteranceId}_${String(card.rank)}` });
  }

  synthesisStart(_info: SynthesisStartInfo): void {
    // The eval has no streaming surface — the terminal done/refusal carries
    // everything the view needs.
  }

  synthesisDelta(_synthesisId: string, _delta: string): void {
    // No streaming surface (the core emits one full-body delta on grounded
    // done; the eval reads the final text off synthesisDone).
  }

  synthesisDone(info: SynthesisDoneInfo): void {
    this.synthesis = {
      kind: 'done',
      rawSynthesis: info.rawSynthesis ?? info.text,
      answer: info.text,
      refusalReason: null,
      citationDetails: info.citationDetails ?? [],
    };
  }

  synthesisRefusal(info: SynthesisRefusalInfo): void {
    this.synthesis = {
      kind: info.reason, // 'refusal' | 'ungrounded'
      rawSynthesis: info.rawSynthesis ?? '',
      answer: info.answer ?? '',
      refusalReason: info.refusalReason ?? null,
      citationDetails: info.citationDetails ?? [],
    };
  }

  synthesisRetract(info: SynthesisRetractInfo): void {
    // U3/KTD3: a streamed answer pulled at the grounding gate. For scoring this
    // is identical to a never-streamed ungrounded/refusal — the answer did NOT
    // stand, so `gateSuppressed`/`isRefusal` semantics must treat it as
    // suppressed. Record it exactly like synthesisRefusal (same `kind`), so the
    // eval's precision/over-refusal accounting is unchanged by the streaming
    // restructure.
    this.synthesis = {
      kind: info.reason, // 'ungrounded' | 'refusal'
      rawSynthesis: info.rawSynthesis ?? '',
      answer: info.answer ?? '',
      refusalReason: info.refusalReason ?? null,
      citationDetails: info.citationDetails ?? [],
    };
  }

  recordMiss(miss: MissRecord): void {
    this.misses.push(miss);
  }

  recordSkip(info: SkipInfo): void {
    this.skip = info;
  }

  recordTrace(trace: PipelineTrace): void {
    this.trace = trace;
  }
}
