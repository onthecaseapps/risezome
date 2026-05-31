'use client';

import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useAppState, type SynthesisRecord } from '../state/app-state';
import { CitationChip } from './citation-chip';
import { SynthesisCard } from './synthesis-card';
import type { CardEvent } from '../types';

/**
 * Streaming + final synthesis rendering.
 *
 * Parses `[N]` and `[N: "..."]` tokens from the synthesis's accumulated
 * text and emits inline `<CitationChip>` components in their place. For
 * streaming syntheses, every in-range token (1 ≤ N ≤ sourceCardIds.length)
 * becomes a chip; the synthesizer's parser corrects the final citation
 * list on `synthesisDone`, at which point we drop tokens whose N is not
 * in `citations` and tidy adjacent whitespace.
 *
 * The cleanup mirrors `finalizeSynthesis` in apps/hud/src/sidebar.ts:
 * any `[N]` or `[N: "..."]` token whose N isn't in the final set is
 * stripped along with leading whitespace; `\s+([.,;:!?])` collapses
 * to the punctuation; `\s{2,}` → single space.
 *
 * The citation regex matches both formats in one pass so cleanup AND
 * chip emission handle the new [N: "verbatim quote"] shape (plan U2)
 * AND the legacy bare-[N] shape (backward compat with pre-deploy
 * syntheses and any Claude misformat).
 *
 * Per-synthesis ordering: newest synthesis on top, matching the stream's
 * `insertBefore(el, firstChild)` semantics.
 */
export function SynthesisStream(): ReactElement {
  const state = useAppState();
  if (state.syntheses.size === 0) {
    return <Fragment />;
  }
  const reversed = Array.from(state.syntheses.values()).reverse();
  return (
    <Fragment>
      {reversed.map((syn) => (
        <SynthesisStreamItem key={syn.synthesisId} syn={syn} />
      ))}
    </Fragment>
  );
}

// Matches both [N] and [N: "..."] in one walk. Captures the rank in
// group 1; group 2 (the quote) is unused at this layer — the quote
// lives in syn.citations[i].quote and U3 wires it through to the chip
// for highlight rendering. We just need to recognize and step over the
// extended form here so it doesn't leak into the rendered body.
const CITATION_REGEX = /\[(\d+)(?::\s*"(?:\\.|[^"])*")?\]/g;

function SynthesisStreamItem({ syn }: { syn: SynthesisRecord }): ReactElement {
  const state = useAppState();
  const sources: CardEvent[] = [];
  for (const id of syn.sourceCardIds) {
    const rec = state.cards.get(id);
    if (rec !== undefined) sources.push(rec.card);
  }

  // Derive the valid-rank set from per-occurrence citation objects.
  // While streaming we keep everything; on done we restrict to the
  // ranks the parser actually emitted (in-range, post-dedup).
  const validCitations: Set<number> | null = syn.streaming
    ? null
    : new Set(syn.citations.map((c) => c.rank));

  const answer = renderAnswer(syn.accumulatedText, syn.sourceCardIds, sources, validCitations);

  // Final citations row: one chip PER UNIQUE SOURCE (not per occurrence)
  // ordered by rank ascending. Per-occurrence chips live inline in the
  // answer body via renderAnswer; this row is the consolidated index.
  const uniqueRanks = !syn.streaming
    ? [...new Set(syn.citations.map((c) => c.rank))].sort((a, b) => a - b)
    : [];
  const citationNodes: ReactNode[] = uniqueRanks.map((rank) => {
    const cardId = syn.sourceCardIds[rank - 1];
    if (typeof cardId !== 'string') return null;
    const sourceCard = state.cards.get(cardId);
    return (
      <CitationChip
        key={`final-${String(rank)}`}
        rank={rank}
        cardId={cardId}
        sourceTitle={sourceCard?.card.title}
      />
    );
  });

  return (
    <SynthesisCard
      synthesisId={syn.synthesisId}
      answer={answer}
      citations={citationNodes.filter((n): n is ReactElement => n !== null)}
      sources={sources}
      streaming={syn.streaming}
    />
  );
}

function renderAnswer(
  text: string,
  sourceCardIds: readonly string[],
  sources: readonly CardEvent[],
  validCitations: Set<number> | null,
): ReactNode {
  // Strip out-of-range citations on done. While streaming, keep everything
  // and let in-range tokens render as chips. The regex matches both
  // bare-[N] and [N: "..."] forms so the full token (and its quote
  // payload) is removed when the rank is out of range — otherwise the
  // quote text would leak into the body.
  let cleaned = text;
  if (validCitations !== null) {
    cleaned = cleaned
      .replace(new RegExp(CITATION_REGEX.source, 'g'), (full, raw: string) => {
        const n = Number(raw);
        return Number.isInteger(n) && validCitations.has(n) ? full : '';
      })
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Walk the cleaned text and emit chips for both [N] and [N: "..."]
  // tokens whose N is in range. The inline chip ignores the quote
  // payload at this layer (the U3 highlight pass reads from
  // syn.citations[i].quote, not from the inline token); we just need
  // to render the chip in the right position and step the regex over
  // the full token shape so non-chip text continues correctly.
  const out: ReactNode[] = [];
  const re = new RegExp(CITATION_REGEX.source, 'g');
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const sourceById = new Map<string, CardEvent>();
  for (const s of sources) sourceById.set(s.cardId, s);

  while ((match = re.exec(cleaned)) !== null) {
    const n = Number(match[1]);
    const cardId = sourceCardIds[n - 1];
    const inRange = Number.isInteger(n) && n >= 1 && n <= sourceCardIds.length;
    const valid =
      validCitations === null ? inRange : inRange && validCitations.has(n);
    if (valid && typeof cardId === 'string') {
      if (match.index > lastIdx) out.push(cleaned.slice(lastIdx, match.index));
      const sourceCard = sourceById.get(cardId);
      out.push(
        <CitationChip
          key={`chip-${String(key++)}`}
          rank={n}
          cardId={cardId}
          sourceTitle={sourceCard?.title}
        />,
      );
      lastIdx = match.index + match[0].length;
    }
  }
  if (lastIdx < cleaned.length) out.push(cleaned.slice(lastIdx));
  return out;
}
