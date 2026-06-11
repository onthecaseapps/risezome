'use client';

import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useAppState, type SynthesisRecord } from '../state/app-state';
import { useSynthesisActivate, SynthesisCard, type SynthesisPhase } from './synthesis-card';
import { CitationChip } from './citation-chip';
import type { CardEvent, SynthesisCitation } from '../types';

/**
 * Pinned syntheses section — renders above the chronological
 * SynthesisStream on the live page (plan U5).
 *
 * Filters state.syntheses for {pinned: true} and renders them in
 * pin-time DESC order (most recently pinned at top). When nothing is
 * pinned the section is omitted entirely (empty React fragment).
 *
 * Pinning removes the synthesis from the chronological feed — the
 * stream's selector excludes pinned. The convention is: pinned
 * syntheses move from the stream to this section; unpinning sends
 * them back. (Decision recorded in U5's S7 test scenarios.)
 *
 * **Code-shape note.** The render logic intentionally duplicates a
 * small amount of synthesis-stream logic (chip walking, source
 * resolution) because lifting it into a shared helper would have to
 * carry six positional args and the duplication is currently 30
 * lines. If a third caller appears (review-page synthesis-pin
 * follow-up?), extract then.
 */
export function PinnedSynthesesSection(): ReactElement {
  const state = useAppState();
  const pinned: SynthesisRecord[] = [];
  for (const syn of state.syntheses.values()) {
    if (syn.pinned) pinned.push(syn);
  }
  if (pinned.length === 0) return <Fragment />;

  // pin-time DESC: most recently pinned at top.
  pinned.sort((a, b) => {
    if (a.pinnedAt === null && b.pinnedAt === null) return 0;
    if (a.pinnedAt === null) return 1;
    if (b.pinnedAt === null) return -1;
    return b.pinnedAt.localeCompare(a.pinnedAt);
  });

  return (
    <section className="pinned-syntheses" aria-label="Pinned summaries">
      <header className="pinned-syntheses-header">
        <span className="pinned-syntheses-label">
          Pinned ({String(pinned.length)})
        </span>
      </header>
      {pinned.map((syn) => (
        <PinnedSynthesisItem key={syn.synthesisId} syn={syn} />
      ))}
    </section>
  );
}

// Matches both [N] and [N: "..."] — same regex synthesis-stream uses.
const CITATION_REGEX = /\[(\d+)(?::\s*"(?:\\.|[^"])*")?\]/g;

function PinnedSynthesisItem({ syn }: { syn: SynthesisRecord }): ReactElement {
  const state = useAppState();
  const sources: CardEvent[] = [];
  for (const id of syn.sourceCardIds) {
    const rec = state.cards.get(id);
    if (rec !== undefined) sources.push(rec.card);
  }

  // Pinned syntheses are always done (you can't pin a streaming one —
  // the pin button only shows on phase==='done'). Phase here mirrors
  // that invariant.
  const phase: SynthesisPhase = syn.streaming
    ? syn.accumulatedText.length === 0
      ? 'placeholder'
      : 'streaming'
    : 'done';

  const validCitations: Set<number> | null =
    phase === 'done' ? new Set(syn.citations.map((c) => c.rank)) : null;

  const answer = renderAnswer(
    syn.accumulatedText,
    syn.sourceCardIds,
    sources,
    validCitations,
    syn.citations,
    phase !== 'done',
  );

  // Additional supporting sources (ALSO: line) resolve to cards the same way
  // sources do; a missing card (retracted locally) is skipped silently.
  const additionalSources: CardEvent[] = [];
  for (const ref of syn.additionalSources ?? []) {
    const rec = state.cards.get(ref.cardId);
    if (rec !== undefined) additionalSources.push(rec.card);
  }

  return (
    <SynthesisCard
      synthesisId={syn.synthesisId}
      phase={phase}
      answer={answer}
      sources={sources}
      citationRecords={syn.citations}
      additionalSources={additionalSources}
      pinned={syn.pinned}
    />
  );
}

function ActivatableCitationChip(props: {
  rank: number;
  cardId: string;
  sourceTitle: string | undefined;
  quote: string | undefined;
  disabled?: boolean;
}): ReactElement {
  const activate = useSynthesisActivate();
  return (
    <CitationChip
      rank={props.rank}
      cardId={props.cardId}
      disabled={props.disabled ?? false}
      {...(props.sourceTitle !== undefined ? { sourceTitle: props.sourceTitle } : {})}
      {...(props.quote !== undefined ? { quote: props.quote } : {})}
      {...(activate !== null ? { onActivate: activate } : {})}
    />
  );
}

function renderAnswer(
  text: string,
  sourceCardIds: readonly string[],
  sources: readonly CardEvent[],
  validCitations: Set<number> | null,
  citations: readonly SynthesisCitation[],
  streaming: boolean,
): ReactNode {
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
  const quoteQueueByRank = new Map<number, string[]>();
  for (const c of citations) {
    let q = quoteQueueByRank.get(c.rank);
    if (q === undefined) {
      q = [];
      quoteQueueByRank.set(c.rank, q);
    }
    q.push(c.quote ?? '');
  }
  function shiftQuote(rank: number): string | undefined {
    const q = quoteQueueByRank.get(rank);
    if (q === undefined || q.length === 0) return undefined;
    const next = q.shift();
    return next === '' ? undefined : next;
  }

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
        <ActivatableCitationChip
          key={`chip-${String(key++)}`}
          rank={n}
          cardId={cardId}
          sourceTitle={sourceCard?.title}
          quote={shiftQuote(n)}
          disabled={streaming}
        />,
      );
      lastIdx = match.index + match[0].length;
    }
  }
  if (lastIdx < cleaned.length) out.push(cleaned.slice(lastIdx));
  return out;
}
