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

export interface NormalizedAdditionalSource {
  rank: number;
  cardId: string;
}

/** The executed-skill result riding as source[0] (tool_source jsonb). */
export interface NormalizedToolSource {
  cardId: string;
  title: string;
  body: string;
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
  /** Retrieved-but-uncited supporting sources (the ALSO: line), resolved to
   *  cardIds by the bot-worker before persisting. Absent/empty on rows from
   *  before the feature. */
  additionalSources?: NormalizedAdditionalSource[];
  /** The executed-skill result riding as source[0] — lets the review page
   *  render a rank-1 (tool) citation as a cited-source row. Absent without
   *  a skill (and on rows from before the column). */
  toolSource?: NormalizedToolSource;
  pinned: boolean;
  pinnedAt: string | null;
  /** The transcript utterance that triggered this synthesis (U6). Null for
   *  rows written before U6. Used to show the question above the answer. */
  triggerUtteranceId?: string | null;
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
 * Normalize the additional_sources jsonb (`[{cardId, rank}, ...]`, written
 * resolved by the bot-worker). Malformed entries are dropped; rows from
 * before the column default to [].
 */
export function normalizeAdditionalSources(raw: unknown): NormalizedAdditionalSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const rank = Number(e['rank']);
    const cardId = e['cardId'];
    if (!Number.isInteger(rank) || rank < 1 || typeof cardId !== 'string' || cardId.length === 0)
      return [];
    return [{ rank, cardId }];
  });
}

/**
 * Normalize the tool_source jsonb ({cardId, title, body}, written by the
 * bot-worker when a skill's result rode synthesis as source[0]). Returns
 * null for pre-feature rows and malformed values.
 */
export function normalizeToolSource(raw: unknown): NormalizedToolSource | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const cardId = t['cardId'];
  const title = t['title'];
  const body = t['body'];
  if (typeof cardId !== 'string' || cardId.length === 0) return null;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  return { cardId, title, body };
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
  const additionalSources = normalizeAdditionalSources(s['additional_sources']);
  if (additionalSources.length > 0) out.additionalSources = additionalSources;
  const toolSource = normalizeToolSource(s['tool_source']);
  if (toolSource !== null) out.toolSource = toolSource;
  if (s['trigger_utterance_id'] != null) out.triggerUtteranceId = s['trigger_utterance_id'] as string;
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

export interface AnchorSynthesis {
  synthesisId: string;
  /** The stored triggering utterance (U6). Null for rows written before U6. */
  triggerUtteranceId: string | null;
  /** Synthesis row created_at, in epoch ms — the basis for the time fallback. */
  createdAtMs: number;
}

export interface UtteranceTime {
  utteranceId: string;
  /** The transcript.data event created_at, in epoch ms. */
  tMs: number;
}

/**
 * Build the review page's `utteranceId → synthesisId` anchor map.
 *
 * Prefer the stored trigger utterance (U6, exact). For rows written before U6
 * (trigger null), fall back to the transcript utterance whose timestamp is the
 * latest at-or-before the synthesis was created — i.e. the question that was
 * just spoken when retrieval fired. This is far more accurate than anchoring to
 * a cited card's surfacing utterance: a card may have been surfaced by an
 * earlier window, and many syntheses cite the same card, which collapsed
 * distinct answers onto one anchor.
 *
 * Syntheses are processed in `createdAtMs` order; the first to claim an
 * utterance wins (collisions are rare once the anchor is time-based).
 */
export function resolveSynthesisAnchors(
  syntheses: readonly AnchorSynthesis[],
  utterances: readonly UtteranceTime[],
): Record<string, string> {
  const sorted = [...utterances].sort((a, b) => a.tMs - b.tMs);
  const ordered = [...syntheses].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const map: Record<string, string> = {};
  for (const s of ordered) {
    let utteranceId = s.triggerUtteranceId;
    if (utteranceId === null) {
      let best: string | null = null;
      for (const u of sorted) {
        if (u.tMs <= s.createdAtMs) best = u.utteranceId;
        else break;
      }
      utteranceId = best;
    }
    if (utteranceId !== null && !(utteranceId in map)) map[utteranceId] = s.synthesisId;
  }
  return map;
}
