'use client';

import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useAppState, type SynthesisRecord } from '../state/app-state';
import { CitationChip } from './citation-chip';
import { SynthesisCard } from './synthesis-card';
import type { CardEvent } from '../types';

/**
 * Streaming + final synthesis rendering.
 *
 * Parses `[N]` tokens from the synthesis's accumulated text and emits
 * inline `<CitationChip>` components in their place. For streaming
 * syntheses, every in-range token (1 ≤ N ≤ sourceCardIds.length) becomes
 * a chip; the synthesizer's parser corrects the final citation list on
 * `synthesisDone`, at which point we drop tokens whose N is not in
 * `citations` and tidy adjacent whitespace.
 *
 * The cleanup mirrors `finalizeSynthesis` in apps/hud/src/sidebar.ts:
 * `\s*\[(\d+)\]` is stripped when N isn't in the final set, then
 * `\s+([.,;:!?])` collapses to the punctuation, and `\s{2,}` → single
 * space.
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

function SynthesisStreamItem({ syn }: { syn: SynthesisRecord }): ReactElement {
  const state = useAppState();
  const sources: CardEvent[] = [];
  for (const id of syn.sourceCardIds) {
    const rec = state.cards.get(id);
    if (rec !== undefined) sources.push(rec.card);
  }

  const validCitations: Set<number> | null = syn.streaming ? null : new Set(syn.citations);

  const answer = renderAnswer(syn.accumulatedText, syn.sourceCardIds, sources, validCitations);

  // Final citations row: one chip per citation in syn.citations, ordered.
  const citationNodes: ReactNode[] = !syn.streaming
    ? syn.citations.map((rank) => {
        const cardId = syn.sourceCardIds[rank - 1];
        if (typeof cardId !== 'string') return null;
        const sourceCard = state.cards.get(cardId);
        return (
          <CitationChip
            key={`final-${rank}`}
            rank={rank}
            cardId={cardId}
            sourceTitle={sourceCard?.card.title}
          />
        );
      })
    : [];

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
  // and let in-range tokens render as chips.
  let cleaned = text;
  if (validCitations !== null) {
    cleaned = cleaned
      .replace(/\s*\[(\d+)\]/g, (m, raw: string) => {
        const n = Number(raw);
        return Number.isInteger(n) && validCitations.has(n) ? m : '';
      })
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Walk the text and emit chips where [N] tokens occur in valid range.
  const out: ReactNode[] = [];
  const re = /\[(\d+)\]/g;
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
