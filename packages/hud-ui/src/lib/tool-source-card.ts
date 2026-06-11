import type { CardEvent, SynthesisToolSource } from '../types';

/**
 * Materialize the executed-skill result riding a synthesis as source[0]
 * into a CardEvent so the sources ledger can render it like any cited row
 * (rank-1 badge, SKILL pill, the tool output as its matched passage). No
 * retrieval card backs the tool source — its synthetic `tool_<traceId>`
 * cardId never appears in the card map — so source resolution falls back
 * to this when a sourceCardId matches the record's toolSource.
 */
export function toolSourceCard(tool: SynthesisToolSource, traceId: string): CardEvent {
  return {
    cardId: tool.cardId,
    docId: tool.cardId,
    source: 'skill',
    type: 'tool',
    title: tool.title,
    snippet: tool.body.slice(0, 400),
    body: tool.body,
    score: 1,
    rank: 1,
    metadata: {},
    surfacedAt: 0,
    triggeredBy: 'question',
    traceId,
  };
}
