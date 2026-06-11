'use client';

import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useAppState, type SynthesisRecord } from '../state/app-state';
import { CitationChip } from './citation-chip';
import { SynthesisCard, useSynthesisActivate, type SynthesisPhase } from './synthesis-card';
import type { CardEvent, SynthesisCitation } from '../types';
import { toolSourceCard } from '../lib/tool-source-card';

/**
 * Streaming + final synthesis rendering.
 *
 * Parses `[N]` and `[N: "..."]` tokens from the synthesis's accumulated
 * text and emits inline `<CitationChip>` components in their place. For
 * streaming syntheses, every in-range token (1 ≤ N ≤ sourceCardIds.length)
 * becomes a chip rendered inert (no click handler — the parser hasn't
 * run yet); the synthesizer's parser corrects the final citation list
 * on `synthesisDone`, at which point we drop tokens whose N is not in
 * `citations` and tidy adjacent whitespace, and chips become live with
 * their per-occurrence quote attached.
 *
 * Per-occurrence quote routing: each inline match in the answer text
 * corresponds (in order, by rank-queue position) to one entry in
 * `syn.citations`. So `[2]` appearing twice with two different quotes
 * routes each occurrence to its own quote — click the first to highlight
 * line A, click the second to highlight line B in the same source.
 *
 * Inline chips fire through the `useSynthesisActivate` context exposed
 * by the parent `SynthesisCard` — no DOM globals, no querySelector.
 *
 * Per-synthesis ordering: newest synthesis on top, matching the stream's
 * `insertBefore(el, firstChild)` semantics.
 */
export function SynthesisStream(): ReactElement {
  const state = useAppState();
  if (state.syntheses.size === 0) {
    return <Fragment />;
  }
  // Pinned syntheses move to PinnedSynthesesSection — exclude them
  // from the chronological feed so the user doesn't see them rendered
  // twice (plan U5).
  const chronological = Array.from(state.syntheses.values())
    .filter((s) => !s.pinned)
    .reverse();
  if (chronological.length === 0) return <Fragment />;
  return (
    <Fragment>
      {chronological.map((syn) => (
        <SynthesisStreamItem key={syn.synthesisId} syn={syn} />
      ))}
    </Fragment>
  );
}

// Matches both [N] and [N: "..."] in one walk. Captures rank in group 1.
// Quote payload (group 2) is consumed for the regex's bookkeeping but
// not used here — quotes live in syn.citations[i].quote, looked up by
// rank-queue order during chip emission.
const CITATION_REGEX = /\[(\d+)(?::\s*"(?:\\.|[^"])*")?\]/g;

export function SynthesisStreamItem({ syn }: { syn: SynthesisRecord }): ReactElement {
  const state = useAppState();
  const sources: CardEvent[] = [];
  for (const id of syn.sourceCardIds) {
    const rec = state.cards.get(id);
    if (rec !== undefined) sources.push(rec.card);
    else if (syn.toolSource !== undefined && syn.toolSource.cardId === id) {
      // The executed-skill result rides as source[0] with no card behind it.
      sources.push(toolSourceCard(syn.toolSource, syn.traceId));
    }
  }

  // Phase derives from streaming + accumulatedText. Placeholder is the
  // window between synthesisStart and the first synthesisDelta (D6).
  // The card is the same React element across all three phases — internal
  // branching avoids the remount that two separate components at the
  // same tree slot would trigger (B4 from review).
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

  // Resolve the question (triggering utterance) from the transcript so the
  // card can show it above the answer. Absent on pre-U6 syntheses or when the
  // utterance isn't in state.
  const question =
    syn.triggerUtteranceId != null ? state.transcript.get(syn.triggerUtteranceId)?.text : undefined;

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
      {...(question !== undefined ? { question } : {})}
    />
  );
}

/**
 * CitationChip wrapper that pulls the activate callback from the
 * surrounding SynthesisCard via context, so the inline answer rendering
 * doesn't have to prop-drill it through every ReactNode child.
 */
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
  // Strip out-of-range citations on done. While streaming, keep
  // everything; in-range tokens render as inert chips.
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

  // Per-occurrence quote routing: walk syn.citations once to build a
  // per-rank queue of quotes. Each in-order match in `cleaned` pops
  // the next quote for its rank.
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
