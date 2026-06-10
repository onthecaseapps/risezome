// Production `PipelineSink` — Supabase persistence + Realtime broadcast (U2).
//
// This is the prod half of the source-in/sink-out seam: the shared core
// (./core.ts) runs the stages transport-free and routes every result through a
// `PipelineSink`; this implementation owns everything transport-specific that
// used to live inline in `maybeRetrieveAndEmit`:
//
//   emitCard           → insert a `cards` row (org-scoped) + persistAndBroadcast
//                        the `card` event + STALE-CARD RETRACTION (retract the
//                        prior live card for the same doc unless pinned).
//   synthesisStart     → insert the `syntheses` row + broadcast `synthesisStart`.
//   synthesisDelta     → broadcast `synthesisDelta` (the single full-body delta
//                        the core emits on grounded-or-nothing; flash-fix).
//   synthesisDone      → update the row to `done` (encrypted body) + broadcast
//                        `synthesisDone`, then close-the-loop onGroundedAnswer.
//   synthesisRefusal   → insert the row as `retracted` (refusal/ungrounded that
//                        never streamed) + broadcast `synthesisRetracted`.
//   synthesisRetract   → UPDATE the existing `running` row to `retracted` (an
//                        answer that DID stream then failed grounding) +
//                        broadcast `synthesisRetracted` so the page clears it.
//   recordMiss         → onMiss (knowledge-gap capture).
//   recordSkip         → log only.
//   recordTrace        → INTENTIONALLY ABSENT: prod = no trace, keep it fast
//                        (KTD4/R5). The core therefore does zero trace work.
//
// Flash-fix buffering lives in the CORE (it buffers the synthesis body and only
// calls synthesisStart/Delta/Done once grounded-or-nothing resolves on `done`);
// this sink's synthesis methods are therefore the post-decision persist/broadcast
// steps — nothing emits until the core says it grounded.

import { randomUUID } from 'node:crypto';
import { CRYPTO_VERSION, encryptForOrgToBytea } from '@risezome/crypto';
import type { MissRecord } from '@risezome/engine/gaps';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistAndBroadcast } from '../db.js';
import type {
  PipelineSink,
  PipelineCard,
  EmittedCard,
  SynthesisStartInfo,
  SynthesisDoneInfo,
  SynthesisRefusalInfo,
  SynthesisRetractInfo,
  SkipInfo,
  PipelineLogger,
} from './contract.js';

/** A live card already surfaced this meeting, keyed by docId. The sink reads +
 *  mutates this so stale-card retraction survives across utterances (it lived on
 *  `RetrievalRuntime.liveCardByDocId` before U2 — the adapter passes that same
 *  map in so meeting-scoped state is unchanged). */
export type LiveCardByDocId = Map<string, string>;

export interface SupabaseSinkArgs {
  readonly db: SupabaseClient;
  readonly meetingId: string;
  readonly orgId: string;
  /** Meeting-scoped doc→live-card map for stale-card retraction (the adapter
   *  passes `runtime.liveCardByDocId`). */
  readonly liveCardByDocId: LiveCardByDocId;
  readonly logger: PipelineLogger;
  /** Knowledge-gap capture: invoked from recordMiss (no_hits / refusal /
   *  ungrounded). The core already gates no_hits on the heuristic. */
  readonly onMiss?: (miss: MissRecord) => void;
  /** Close-the-loop: invoked with the grounded answer body on synthesisDone so
   *  the summarizer can retire the open question it resolved. The grounded
   *  source docIds (Mechanism B) ride along so the adapter can record the
   *  answered source-set for same-source dedup. */
  readonly onGroundedAnswer?: (text: string, sourceDocIds: readonly string[]) => void;
  /** Demand-driven rolling-summary refresh: invoked once per synthesis attempt
   *  (the first terminal event — start OR refusal — for a synthesisId), the same
   *  "a question is being answered" signal `maybeRetrieveAndEmit` fired right
   *  before kicking off synthesis. */
  readonly onSynthesisRequested?: () => void;
}

/**
 * Build the prod Supabase sink. ORG-SCOPING: every read/write is filtered by
 * `orgId` (defense-in-depth — the service-role client bypasses RLS), and the
 * sink only ever touches `args.orgId` / `args.meetingId`, never a caller-supplied
 * value from the card/synthesis payloads.
 */
export function createSupabaseSink(args: SupabaseSinkArgs): PipelineSink {
  const { db, meetingId, orgId, liveCardByDocId, logger } = args;

  // Per-synthesis bookkeeping so synthesisDone/Refusal can find the row they
  // need and so onSynthesisRequested fires exactly once per attempt. The core
  // calls synthesisStart→Delta→Done for a grounded answer, or synthesisRefusal
  // alone for a refused/ungrounded one.
  const requestedSyntheses = new Set<string>();
  const startedCardIds = new Map<string, readonly string[]>();
  const startedTraceIds = new Map<string, string>();

  const fireRequestedOnce = (synthesisId: string): void => {
    if (requestedSyntheses.has(synthesisId)) return;
    requestedSyntheses.add(synthesisId);
    args.onSynthesisRequested?.();
  };

  // F4: serialize all fire-and-forget persist+broadcast work through one
  // promise chain. Independent `void (async () => ...)()` chains let event_id
  // order invert semantic order (e.g. a delta row persisted BEFORE its start
  // row — replay would then drop the text forever, since deltas for an
  // unknown synthesis are no-ops). The .catch keeps the chain alive after a
  // failure; each work fn keeps its own granular error handling.
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (label: string, work: () => Promise<void>): void => {
    tail = tail.then(work).catch((err: unknown) => {
      logger.warn({ err }, label);
    });
  };

  return {
    async emitCard(card: PipelineCard): Promise<EmittedCard | null> {
      // Persist the card row (RLS-scoped by org_id; insert via service role)
      // BEFORE the broadcast, per R23a.
      const cardId = `card_${randomUUID()}`;
      const surfacedAtIso = new Date().toISOString();
      const { error: cardErr } = await db.from('cards').insert({
        card_id: cardId,
        meeting_id: meetingId,
        org_id: orgId,
        doc_id: card.docId,
        source: card.source,
        type: card.type,
        title: card.title,
        snippet: card.snippet,
        body: card.body,
        score: card.score,
        rank: card.rank,
        metadata: card.metadata,
        surfaced_at: surfacedAtIso,
        triggered_by: 'window',
        utterance_id: card.utteranceId,
        trace_id: card.traceId,
        url: card.url ?? null,
      });
      if (cardErr !== null) {
        logger.warn({ err: cardErr, cardId }, 'retrieval.card.insert.failed');
        return null; // the core skips a dropped card as a synthesis source
      }

      // Broadcast in the shape the live page's reducer expects (matches
      // @risezome/hud-ui's CardEvent).
      await persistAndBroadcast(db, {
        meetingId,
        orgId,
        type: 'card',
        payload: {
          card: {
            cardId,
            docId: card.docId,
            source: card.source,
            type: card.type,
            title: card.title,
            snippet: card.snippet,
            body: card.body,
            score: card.score,
            rank: card.rank,
            isSummary: card.isSummary,
            metadata: card.metadata,
            surfacedAt: Date.now(),
            triggeredBy: 'window',
            utteranceId: card.utteranceId,
            traceId: card.traceId,
            ...(card.url !== undefined ? { url: card.url } : {}),
          },
        },
      });

      // Stale-card retraction: if we already surfaced a card for this docId,
      // retract the old one so the stream doesn't show the same chunk twice.
      // Pinned cards are NEVER retracted by this path.
      const priorCardId = liveCardByDocId.get(card.docId);
      if (priorCardId !== undefined && priorCardId !== cardId) {
        await retractIfNotPinned(db, priorCardId, orgId, meetingId, logger);
      }
      liveCardByDocId.set(card.docId, cardId);

      return { cardId };
    },

    synthesisStart(info: SynthesisStartInfo): void {
      fireRequestedOnce(info.synthesisId);
      startedCardIds.set(info.synthesisId, info.sourceCardIds);
      startedTraceIds.set(info.synthesisId, info.traceId);
      // syntheses row keyed by synthesis_id; inserted as `running` so a reconnect
      // can rebuild from the DB. The core only calls synthesisStart once the
      // answer GROUNDED (flash-fix), so by the time we insert + broadcast the
      // answer is decided — no optimistic-then-retracted flash on the live page.
      enqueue('synthesis.start.persist.failed', async () => {
        const insertResult = await db.from('syntheses').insert({
          synthesis_id: info.synthesisId,
          meeting_id: meetingId,
          org_id: orgId,
          source_card_ids: info.sourceCardIds,
          status: 'running',
          citations: [],
          trace_id: info.traceId,
          trigger_utterance_id: info.utteranceId,
        });
        if (insertResult.error !== null) {
          logger.warn({ err: insertResult.error, synthesisId: info.synthesisId }, 'synthesis.insert.failed');
          return;
        }
        await persistAndBroadcast(db, {
          meetingId,
          orgId,
          type: 'synthesisStart',
          payload: {
            start: {
              synthesisId: info.synthesisId,
              sourceCardIds: info.sourceCardIds,
              traceId: info.traceId,
              triggerUtteranceId: info.utteranceId,
            },
          },
        });
      });
    },

    synthesisDelta(synthesisId: string, delta: string): void {
      enqueue('synthesis.delta.persist.failed', async () => {
        await persistAndBroadcast(db, {
          meetingId,
          orgId,
          type: 'synthesisDelta',
          payload: { delta: { synthesisId, delta } },
        });
      });
    },

    synthesisDone(info: SynthesisDoneInfo): void {
      enqueue('synthesis.done.persist.failed', async () => {
        // U9: encrypt the grounded body under the org's per-org KMS key.
        let encrypted: string;
        try {
          encrypted = await encryptForOrgToBytea(orgId, info.text);
        } catch (err) {
          logger.warn({ err, synthesisId: info.synthesisId }, 'synthesis.encrypt.failed');
          return;
        }
        await db
          .from('syntheses')
          .update({
            status: 'done',
            accumulated_text_enc: encrypted,
            synth_key_version: CRYPTO_VERSION.KMS_ESDK,
            stop_reason: info.stopReason,
            citations: info.citations,
            latency_ms: info.latencyMs,
          })
          .eq('synthesis_id', info.synthesisId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly

        await persistAndBroadcast(db, {
          meetingId,
          orgId,
          type: 'synthesisDone',
          payload: {
            done: {
              synthesisId: info.synthesisId,
              stopReason: info.stopReason,
              citations: info.citations,
              ttftMs: 0, // not measured at this layer
              latencyMs: info.latencyMs,
              // F4b: carry the full final text so the live page self-heals a
              // dropped delta. No new plaintext exposure: synthesisDelta
              // events already persist the same text plaintext in
              // meeting_events (only transcript.data is stripped/encrypted
              // there); the encrypted-at-rest copy remains the syntheses row.
              text: info.text,
            },
          },
        });

        logger.info(
          {
            synthesisId: info.synthesisId,
            meetingId,
            latencyMs: info.latencyMs,
            citationTotal: info.citations.length,
          },
          'synthesis.done',
        );

        // Close the loop: hand the grounded answer to the summarizer so the
        // open question it resolved retires from the next rolling summary.
        args.onGroundedAnswer?.(info.text, info.sourceDocIds ?? []);

        startedCardIds.delete(info.synthesisId);
        startedTraceIds.delete(info.synthesisId);
      });
    },

    synthesisRefusal(info: SynthesisRefusalInfo): void {
      fireRequestedOnce(info.synthesisId);
      // The core suppresses refusals + ungrounded answers BEFORE calling
      // synthesisStart, so there is no `running` row to update — insert the
      // synthesis directly as `retracted` so reconnect-fetch sees the terminal
      // state and the right panel collapses gracefully.
      enqueue('synthesis.refusal.persist.failed', async () => {
        const insertResult = await db.from('syntheses').insert({
          synthesis_id: info.synthesisId,
          meeting_id: meetingId,
          org_id: orgId,
          source_card_ids: [],
          status: 'retracted',
          retracted_at: new Date().toISOString(),
          retracted_reason: info.reason,
          citations: [],
          latency_ms: info.latencyMs,
          trace_id: info.traceId,
          trigger_utterance_id: info.utteranceId,
        });
        if (insertResult.error !== null) {
          logger.warn({ err: insertResult.error, synthesisId: info.synthesisId }, 'synthesis.insert.failed');
          // Still broadcast the retraction so the live page collapses the panel.
        }
        await persistAndBroadcast(db, {
          meetingId,
          orgId,
          type: 'synthesisRetracted',
          payload: { retracted: { synthesisId: info.synthesisId, reason: 'source-retracted' } },
        });
        logger.info(
          { synthesisId: info.synthesisId, meetingId, reason: info.reason, latencyMs: info.latencyMs },
          info.reason === 'refusal' ? 'synthesis.refusal' : 'synthesis.ungrounded',
        );
      });
    },

    synthesisRetract(info: SynthesisRetractInfo): void {
      fireRequestedOnce(info.synthesisId);
      // U3/KTD3: the answer ALREADY streamed (a `running` row exists from
      // synthesisStart), so UPDATE it to `retracted` rather than inserting a
      // new row, then broadcast the retraction so the live page clears the
      // streamed prose. This is the rare "STATUS_ANSWER that failed citation
      // verification" path; a STATUS_NO_CONTEXT refusal never streams and goes
      // through synthesisRefusal instead.
      enqueue('synthesis.retract.persist.failed', async () => {
        const updateResult = await db
          .from('syntheses')
          .update({
            status: 'retracted',
            retracted_at: new Date().toISOString(),
            retracted_reason: info.reason,
            latency_ms: info.latencyMs,
          })
          .eq('synthesis_id', info.synthesisId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        if (updateResult.error !== null) {
          logger.warn(
            { err: updateResult.error, synthesisId: info.synthesisId },
            'synthesis.retract.update.failed',
          );
          // Still broadcast the retraction so the live page collapses the panel.
        }
        await persistAndBroadcast(db, {
          meetingId,
          orgId,
          type: 'synthesisRetracted',
          payload: { retracted: { synthesisId: info.synthesisId, reason: 'source-retracted' } },
        });
        logger.info(
          { synthesisId: info.synthesisId, meetingId, reason: info.reason, latencyMs: info.latencyMs },
          'synthesis.retracted',
        );
        startedCardIds.delete(info.synthesisId);
        startedTraceIds.delete(info.synthesisId);
      });
    },

    recordMiss(miss: MissRecord): void {
      args.onMiss?.(miss);
    },

    recordSkip(info: SkipInfo): void {
      logger.info(
        { meetingId, stage: info.stage, reason: info.reason, ...(info.confidence !== undefined ? { confidence: info.confidence } : {}) },
        info.stage === 'heuristic-gate' ? 'synthesis.skipped.filler' : 'synthesis.skipped.llm',
      );
    },

    // recordTrace INTENTIONALLY OMITTED — prod runs trace-free (KTD4/R5). The
    // core sees `recordTrace === undefined` and assembles no trace.
  };
}

/**
 * Mark a prior card as retracted (verifier-downgraded) unless it's been pinned
 * by the user. Broadcasts cardRetracted so live page subscribers remove it
 * immediately. Best-effort. Ported verbatim from `retrieval.ts`.
 */
async function retractIfNotPinned(
  db: SupabaseClient,
  cardId: string,
  orgId: string,
  meetingId: string,
  logger: PipelineLogger,
): Promise<void> {
  const { data: priorRow } = await db
    .from('cards')
    .select('pinned')
    .eq('card_id', cardId)
    .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    .maybeSingle();
  if (priorRow === null) return;
  if (priorRow.pinned === true) return; // pinned cards are sacred

  const { error: updateErr } = await db
    .from('cards')
    .update({
      retracted_at: new Date().toISOString(),
      retracted_reason: 'verifier-downgraded',
    })
    .eq('card_id', cardId)
    .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    .is('retracted_at', null);
  if (updateErr !== null) {
    logger.warn({ err: updateErr, cardId }, 'retraction.update.failed');
    return;
  }

  await persistAndBroadcast(db, {
    meetingId,
    orgId,
    type: 'cardRetracted',
    payload: { retracted: { cardId, reason: 'verifier-downgraded' } },
  });
  logger.info({ cardId, meetingId }, 'card.retracted.verifier-downgraded');
}
