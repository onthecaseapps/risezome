'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { CardEvent, SynthesisCitation } from '../types';
import { SourceCardExpanded } from './source-card-expanded';

/**
 * AI Summary card. Internally branches between three phases — placeholder,
 * streaming, done — all rendered by the SAME outer `<article>` so React
 * reconciliation updates in place and no remount fires between phases
 * (plan B4 from review: two separate components at the same tree slot
 * would unmount-and-remount on phase change despite stable keys).
 *
 * Phase contract:
 *   placeholder → synthesisStart fired but no text yet. Shows shimmer
 *                 skeleton bars + an optional "searching across …"
 *                 status line listing source titles. aria-busy=true.
 *   streaming  → text is arriving. Shows the typing cursor; chips are
 *                 inert (disabled) since the parser hasn't run yet.
 *                 aria-busy=true, aria-live=polite.
 *   done       → final state. Citations + sources rendered;
 *                 inline + consolidated chips become activatable.
 *
 * Per-synthesis expansion state lives in component state (useState) not
 * the global reducer. Rationale: it's transient UI state with no
 * persistence need, no cross-tab sync, no Realtime broadcast. The
 * reducer holds durable data (cards, syntheses, gaps); expansion is a
 * per-render UI affordance.
 */
export type SynthesisPhase = 'placeholder' | 'streaming' | 'done';

export interface SynthesisCardProps {
  readonly synthesisId: string;
  readonly phase: SynthesisPhase;
  /** Pre-rendered answer with `<CitationChip>` interpolated by
   *  SynthesisStream. Empty during placeholder phase. */
  readonly answer: ReactNode;
  /** Consolidated citation chip nodes shown beneath the answer (final
   *  row). Empty in placeholder + streaming. */
  readonly citations: ReactNode[];
  /** Cards consolidated under the summary, in `sourceCardIds` order.
   *  Available during placeholder too (used for source-title line). */
  readonly sources: readonly CardEvent[];
  /** Per-occurrence citation records from the synthesis. Used by inline
   *  chip activations to look up the right quote when the chip fires
   *  onActivate. */
  readonly citationRecords?: readonly SynthesisCitation[];
  readonly entering?: boolean;
}

interface ExpansionState {
  readonly cardId: string;
  readonly quote: string | undefined;
}

export function SynthesisCard({
  synthesisId,
  phase,
  answer,
  citations,
  sources,
  entering = false,
}: SynthesisCardProps): ReactElement {
  const className = [
    'card',
    'synthesis',
    `synthesis-phase-${phase}`,
    entering ? 'is-entering' : null,
  ]
    .filter(Boolean)
    .join(' ');

  // Per-synthesis expansion state. Cleared on every render of a different
  // synthesisId because useState binds to component instance + key.
  const [expansion, setExpansion] = useState<ExpansionState | null>(null);

  const activate = useCallback(
    (args: { rank: number; cardId: string; quote: string | undefined }) => {
      setExpansion((current) => {
        if (
          current !== null &&
          current.cardId === args.cardId &&
          current.quote === args.quote
        ) {
          return null;
        }
        return { cardId: args.cardId, quote: args.quote };
      });
    },
    [],
  );

  const isDone = phase === 'done';
  const ariaBusy = phase !== 'done';
  // Stream phase reads politely so SRs follow along; placeholder is
  // intentionally silent (the shimmer means nothing to announce).
  const ariaLive: 'off' | 'polite' = phase === 'streaming' ? 'polite' : 'off';

  return (
    <SynthesisCardActivateContext.Provider value={activate}>
      <article
        className={className}
        data-kind="synthesis"
        data-synthesis-id={synthesisId}
        data-phase={phase}
        aria-busy={ariaBusy}
      >
        <span className="ai-label">AI Summary</span>
        <div className="synthesis-body" aria-live={ariaLive}>
          {phase === 'placeholder' ? (
            <SkeletonBars />
          ) : (
            <>
              {answer}
              {phase === 'streaming' && (
                <span className="synthesis-cursor" aria-hidden="true">
                  ▊
                </span>
              )}
            </>
          )}
        </div>

        {phase === 'placeholder' && sources.length > 0 && (
          <PlaceholderSourceTitles sources={sources} />
        )}

        {isDone && citations.length > 0 && <div className="citations">{citations}</div>}

        {isDone && sources.length > 0 && (
          <div className="synthesis-sources">
            <div className="synthesis-sources-label">
              Sources ({String(sources.length)})
            </div>
            <div className="synthesis-sources-list">
              {sources.map((source) => {
                const isOpen = expansion !== null && expansion.cardId === source.cardId;
                const passQuote = isOpen && expansion !== null && expansion.quote !== undefined;
                return (
                  <SourceCardExpanded
                    key={source.cardId}
                    source={source}
                    open={isOpen}
                    {...(passQuote ? { quote: expansion!.quote as string } : {})}
                  />
                );
              })}
            </div>
          </div>
        )}
      </article>
    </SynthesisCardActivateContext.Provider>
  );
}

/**
 * Two-line shimmer placeholder. Width approximates a typical 1-3
 * sentence answer; the actual answer will replace this in-place once
 * streaming begins. aria-hidden so screen readers don't announce the
 * skeleton (the outer article has aria-busy=true to signal "work in
 * progress" instead).
 */
function SkeletonBars(): ReactElement {
  return (
    <div className="synthesis-skeleton" aria-hidden="true" role="presentation">
      <span className="synthesis-skeleton-bar w-90" />
      <span className="synthesis-skeleton-bar w-60" />
    </div>
  );
}

/**
 * Muted "searching across X, Y, Z" line shown beneath the skeleton.
 * Deliberately not styled like cards — no border, no chrome, no per-
 * title click target — so it reads as status text, not the resurrected
 * card stream the redesign removed (H5 from review).
 */
function PlaceholderSourceTitles({
  sources,
}: {
  sources: readonly CardEvent[];
}): ReactElement {
  const label =
    sources.length === 1
      ? 'Searching across 1 source:'
      : `Searching across ${String(sources.length)} sources:`;
  return (
    <div className="synthesis-placeholder-sources">
      <span className="placeholder-sources-label">{label}</span>{' '}
      <span className="placeholder-sources-titles">
        {sources.map((s) => s.title).join(' · ')}
      </span>
    </div>
  );
}

type ActivateFn = (args: { rank: number; cardId: string; quote: string | undefined }) => void;
const SynthesisCardActivateContext = createContext<ActivateFn | null>(null);

/** Called from CitationChip wrappers in synthesis-stream to get the
 *  parent SynthesisCard's activate callback. Returns null when used
 *  outside a SynthesisCard (chip stays inert). */
export function useSynthesisActivate(): ActivateFn | null {
  return useContext(SynthesisCardActivateContext);
}
