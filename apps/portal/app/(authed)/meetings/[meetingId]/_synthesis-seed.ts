import type { SynthesisErrorCode } from '@risezome/hud-ui';

/**
 * Shared synthesis-row → seed mapping for the live and review pages, so both
 * render synthesis cards from identical, citation-normalized state. Extracted
 * from the live page so the review page (U8) renders the same way.
 */

export interface NormalizedCitation {
  rank: number;
  cardId: string;
  position: number;
  quote?: string;
}

export interface InitialSynthesis {
  synthesisId: string;
  sourceCardIds: string[];
  accumulatedText: string;
  status: 'running' | 'done' | 'errored' | 'retracted';
  traceId: string;
  stopReason?: string;
  errorCode?: SynthesisErrorCode;
  errorMessage?: string;
  citations: NormalizedCitation[];
  pinned: boolean;
  pinnedAt: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  ttftMs?: number;
  latencyMs?: number;
}

/**
 * Normalize the citations jsonb into the post-U2 object shape regardless of
 * which shape the row was written in. New rows already have
 * `[{rank, cardId, position, quote?}, ...]`. Old rows have `[1, 2, 3]` — for
 * each rank we look up the cardId via sourceCardIds[rank-1] and scan
 * accumulated_text for the first `[N]` to get position. The migration
 * backfills on disk; this is the belt-and-suspenders for any unmigrated row
 * (and the basis for the review page rendering old rows correctly — R8).
 */
export function normalizeCitations(
  raw: unknown,
  sourceCardIds: readonly string[],
  accumulatedText: string,
): NormalizedCitation[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];
  if (typeof raw[0] === 'object' && raw[0] !== null && 'rank' in (raw[0] as object)) {
    return (raw as Array<Record<string, unknown>>).map((c) => {
      const rank = Number(c['rank']);
      const cardId =
        typeof c['cardId'] === 'string' ? (c['cardId'] as string) : (sourceCardIds[rank - 1] ?? '');
      const position = Number(c['position'] ?? 0);
      const quote = typeof c['quote'] === 'string' ? (c['quote'] as string) : undefined;
      return quote !== undefined ? { rank, cardId, position, quote } : { rank, cardId, position };
    });
  }
  return (raw as number[]).flatMap((rank) => {
    if (!Number.isInteger(rank) || rank < 1 || rank > sourceCardIds.length) return [];
    const cardId = sourceCardIds[rank - 1];
    if (cardId === undefined) return [];
    const idx = accumulatedText.indexOf(`[${String(rank)}]`);
    return [{ rank, cardId, position: idx >= 0 ? idx : 0 }];
  });
}

/**
 * Map a raw `syntheses` row (with the full column set both pages select) into
 * the `InitialSynthesis` shape the reducer seeds from.
 */
export function mapSynthesisRow(s: Record<string, unknown>): InitialSynthesis {
  const sourceCardIds = (s['source_card_ids'] as string[]) ?? [];
  const accumulatedText = s['accumulated_text'] as string;
  const out: InitialSynthesis = {
    synthesisId: s['synthesis_id'] as string,
    sourceCardIds,
    accumulatedText,
    status: s['status'] as 'running' | 'done' | 'errored' | 'retracted',
    traceId: s['trace_id'] as string,
    citations: normalizeCitations(s['citations'], sourceCardIds, accumulatedText),
    pinned: (s['pinned'] as boolean | null) ?? false,
    pinnedAt: (s['pinned_at'] as string | null) ?? null,
  };
  if (s['stop_reason'] != null) out.stopReason = s['stop_reason'] as string;
  if (s['error_code'] != null) out.errorCode = s['error_code'] as SynthesisErrorCode;
  if (s['error_message'] != null) out.errorMessage = s['error_message'] as string;
  if (s['ttft_ms'] != null) out.ttftMs = s['ttft_ms'] as number;
  if (s['latency_ms'] != null) out.latencyMs = s['latency_ms'] as number;
  if (s['input_tokens'] != null) {
    out.usage = {
      inputTokens: s['input_tokens'] as number,
      outputTokens: (s['output_tokens'] as number) ?? 0,
      cacheReadTokens: (s['cache_read_tokens'] as number) ?? 0,
      cacheCreationTokens: (s['cache_creation_tokens'] as number) ?? 0,
    };
  }
  return out;
}
