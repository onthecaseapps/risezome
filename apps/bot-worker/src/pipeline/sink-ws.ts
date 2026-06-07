// Dev-sidecar `PipelineSink` — WebSocket JSON events + per-stage trace (U3).
//
// This is the dev half of the source-in/sink-out seam: the shared core
// (./core.ts) runs the stages transport-free and routes every result through a
// `PipelineSink`; this implementation maps each result to the EXISTING
// local-debug WS event vocabulary the portal client already renders, so the
// dev page keeps working unchanged for the non-trace events:
//
//   emitCard           → a `card` event (1-indexed rank for display; `distance`
//                        + derived `score` so the page's relevance line renders).
//   synthesisStart     → `synthesisStart` event.
//   synthesisDelta     → `synthesisDelta` event (the single full-body delta the
//                        core emits on grounded-or-nothing; flash-fix).
//   synthesisDone      → `synthesisDone` event (+ onComplete close-the-loop).
//   synthesisRefusal   → `synthesisRefusal` event (reason → accumulatedText) —
//                        the never-streamed refusal/ungrounded case (UI no-op).
//   synthesisRetract   → `synthesisRetract` event — the streamed-then-ungrounded
//                        case; the page clears the in-progress synthesis.
//   recordMiss         → log only (the dev page has no knowledge-gap surface).
//   recordSkip         → `retrieval-skip` event (reason carries the gate/miss
//                        reason: `heuristic-filler` / `classifier-skip`).
//   recordSkillResult  → a `skillResult` event (the raw executed-skill answer as
//                        its own card — independent of synthesis; dev-only, prod/
//                        eval omit it. The tool source still rides synthesis[0]).
//   recordTrace        → a NEW `trace` event carrying the PipelineTrace. This is
//                        the ONLY behavioral difference from the prod sink: dev
//                        = trace ON (KTD4/R5 — prod omits recordTrace entirely).
//
// Flash-fix buffering lives in the CORE (it buffers the synthesis body and only
// calls synthesisStart/Delta/Done once grounded-or-nothing resolves on `done`);
// this sink's synthesis methods are therefore the post-decision broadcasts —
// nothing emits until the core says it grounded.

import type { MissRecord } from '@risezome/engine/gaps';
import type { WebSocket } from 'ws';
import type {
  PipelineSink,
  PipelineCard,
  EmittedCard,
  SynthesisStartInfo,
  SynthesisDoneInfo,
  SynthesisRefusalInfo,
  SynthesisRetractInfo,
  SkipInfo,
  SkillResultInfo,
  PipelineTrace,
  PipelineLogger,
} from './contract.js';

export interface WsSinkArgs {
  readonly socket: WebSocket;
  /** Stable id the handler assigned to this utterance's synthesis, used so the
   *  `synthesisStart`/`Delta`/`Done`/`Refusal` events the page already keys on
   *  stay consistent with the per-utterance abort plumbing. The core assigns its
   *  own internal synthesis id; this sink rewrites every synthesis event onto the
   *  handler's id so the page's abort/supersede logic keeps working. */
  readonly synthesisId: string;
  readonly logger: PipelineLogger;
  /** Close-the-loop: invoked with the grounded answer body on synthesisDone so
   *  the handler can feed it to the summarizer (retire the resolved question). */
  readonly onComplete?: (answerText: string) => void;
  /** Mechanism A/B record side: invoked with the grounded answer body + its
   *  source docIds on synthesisDone so the local-debug handler can void the
   *  answered transcript spans and remember the answered source set (mirrors the
   *  prod Supabase sink's `onGroundedAnswer`). */
  readonly onGroundedAnswer?: (text: string, sourceDocIds: readonly string[]) => void;
}

/** WS send helper — drop on a non-OPEN socket (mirrors the handler's `send`). */
function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== 1) return; // OPEN
  socket.send(JSON.stringify(payload));
}

/**
 * Build the dev WS sink. Maps the sink-agnostic core results onto the existing
 * local-debug event shapes (so the portal client is unchanged) and adds the new
 * `trace` event. Unlike the prod sink it DEFINES `recordTrace`, so the core
 * assembles + emits a per-stage trace for the dev page.
 */
export function createWsSink(args: WsSinkArgs): PipelineSink {
  const { socket, synthesisId, logger } = args;
  return {
    emitCard(card: PipelineCard): Promise<EmittedCard | null> {
      // Distance lives on the card metadata (the page derives its own
      // `1 - distance` relevance from it); undefined for an FTS-only hit.
      const distance =
        typeof card.metadata.distance === 'number' ? card.metadata.distance : undefined;
      const cardId = cardIdFor(card);
      send(socket, {
        type: 'card',
        traceId: card.traceId,
        utteranceId: card.utteranceId,
        cardId, // matches what emitCard returns, so synthesis citations resolve
        rank: card.rank + 1, // page displays a 1-indexed rank ([1], [2], …)
        docId: card.docId,
        title: card.title,
        source: card.source,
        docType: card.type,
        url: card.url ?? null,
        snippet: card.snippet,
        body: card.body,
        score: card.score,
        isSummary: card.isSummary,
        ...(distance !== undefined ? { distance } : {}),
      });
      // The dev page treats the card id as opaque + only uses it to map
      // synthesis citations back to a surfaced card; the core threads whatever
      // we return into the synthesis source-card list. Return the same id the
      // `card` event carried so the two stay consistent.
      return Promise.resolve({ cardId });
    },

    synthesisStart(info: SynthesisStartInfo): void {
      send(socket, {
        type: 'synthesisStart',
        synthesisId,
        sourceCardIds: info.sourceCardIds,
        traceId: info.traceId,
        utteranceId: info.utteranceId,
      });
    },

    synthesisDelta(_synthesisId: string, delta: string): void {
      send(socket, { type: 'synthesisDelta', synthesisId, delta });
    },

    synthesisDone(info: SynthesisDoneInfo): void {
      send(socket, {
        type: 'synthesisDone',
        synthesisId,
        stopReason: info.stopReason,
        accumulatedText: info.text,
        citations: info.citations,
      });
      args.onComplete?.(info.text);
      args.onGroundedAnswer?.(info.text, info.sourceDocIds ?? []);
    },

    synthesisRefusal(info: SynthesisRefusalInfo): void {
      // No synthesisStart was emitted (the core suppresses refusals/ungrounded
      // before grounding), so this is a UI no-op for an unknown synthesisId —
      // nothing flashes. The reason is surfaced in `accumulatedText` for the
      // debug panel (production would render nothing).
      send(socket, {
        type: 'synthesisRefusal',
        synthesisId,
        stopReason: 'end_turn',
        accumulatedText:
          info.reason === 'refusal'
            ? 'No relevant context.'
            : 'Ungrounded: the answer had no citation matching a retrieved source, so it was suppressed.',
        citations: [],
      });
    },

    synthesisRetract(_info: SynthesisRetractInfo): void {
      // The answer DID stream (synthesisStart + deltas reached the page), so —
      // unlike synthesisRefusal — we must clear it. Emit a `synthesisRetract`
      // event the debug page maps to the reducer's synthesisRetracted (drops
      // the in-progress record). U3/KTD3 grounded-or-nothing: a streamed answer
      // that failed the grounding gate is pulled, not left standing.
      send(socket, { type: 'synthesisRetract', synthesisId });
    },

    recordMiss(miss: MissRecord): void {
      // The dev page has no knowledge-gap surface; the trace's stage records
      // already carry the refusal/no-hits reason. Log for parity with prod.
      logger.info(
        { utteranceId: miss.utteranceId, reason: miss.reason },
        'local-debug.miss',
      );
    },

    recordSkip(info: SkipInfo): void {
      send(socket, {
        type: 'retrieval-skip',
        reason: info.stage === 'heuristic-gate' ? 'heuristic-filler' : 'classifier-skip',
        ...(info.confidence !== undefined ? { confidence: info.confidence } : {}),
        detail: info.reason,
      });
    },

    recordSkillResult(result: SkillResultInfo): void {
      // Emit the structured tool answer as its own `skillResult` event so the
      // page renders the raw skill answer as a standalone card, independent of
      // whether the synthesizer relays it (it can refuse). Exact pre-U3 shape.
      send(socket, {
        type: 'skillResult',
        traceId: result.traceId,
        utteranceId: result.utteranceId,
        skillName: result.skillName,
        args: result.args,
        kind: result.kind,
        summary: result.summary,
        items: result.items,
      });
    },

    recordTrace(trace: PipelineTrace): void {
      send(socket, {
        type: 'trace',
        traceId: trace.traceId,
        utteranceId: trace.utteranceId,
        meetingId: trace.meetingId,
        stages: trace.stages,
      });
    },
  };
}

/** Derive the opaque card id the sink hands back to the core. The dev page only
 *  uses it to map a synthesis citation back to a surfaced card, so a stable,
 *  per-utterance-unique id keyed off the doc + rank is sufficient. */
function cardIdFor(card: PipelineCard): string {
  return `dbg_${card.utteranceId}_${String(card.rank)}`;
}
