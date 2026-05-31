'use client';

import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import type { CardEvent, SynthesisCitation } from '../types';
import { SourceCardExpanded } from './source-card-expanded';

/**
 * AI Summary card with inline citations and inline-expandable sources
 * beneath the answer body (plan U3).
 *
 * The card owns per-synthesis expansion state:
 *   { expandedSourceId: string | null; activeQuote: string | undefined }
 *
 * Click flow:
 *   1. SynthesisStream's renderAnswer emits `<CitationChip>` per `[N]`
 *      token in the answer, passing each chip an `onActivate` callback
 *      bound to this card.
 *   2. User clicks chip → onActivate({rank, cardId, quote}) fires.
 *   3. If cardId === expandedSourceId (and the quote matches), collapse.
 *      Else open / re-target.
 *   4. Re-render flows: `<SourceCardExpanded open={...} quote={...}>`
 *      receives the new quote and re-runs its highlight effect, scrolling
 *      the `<mark>` into view.
 *
 * The `Sources (N)` header line + the inline sources list both reflect
 * the synthesis's source array. Inline chips and the consolidated row
 * at the bottom both call the same `activateSource` callback.
 *
 * **Note on per-synthesis state.** Expansion state lives in component
 * state (useState) not the global reducer. Rationale: it's transient UI
 * state with no persistence need, no cross-tab sync, no Realtime
 * broadcast. The reducer holds durable data (cards, syntheses, gaps);
 * expansion is a per-render UI affordance.
 */
export interface SynthesisCardProps {
  readonly synthesisId: string;
  /** Pre-rendered answer with `<CitationChip>` interpolated by SynthesisStream. */
  readonly answer: ReactNode;
  /** Consolidated citation chip nodes shown beneath the answer (final row). */
  readonly citations: ReactNode[];
  /** Cards consolidated under the summary, in `sourceCardIds` order. */
  readonly sources: readonly CardEvent[];
  /** Per-occurrence citation records from the synthesis. Used by inline
   *  chip activations to look up the right quote when the chip fires
   *  onActivate. */
  readonly citationRecords?: readonly SynthesisCitation[];
  readonly streaming?: boolean;
  readonly entering?: boolean;
}

interface ExpansionState {
  readonly cardId: string;
  readonly quote: string | undefined;
}

export function SynthesisCard({
  synthesisId,
  answer,
  citations,
  sources,
  streaming = false,
  entering = false,
}: SynthesisCardProps): ReactElement {
  const className = ['card', 'synthesis', entering ? 'is-entering' : null]
    .filter(Boolean)
    .join(' ');

  // Per-synthesis expansion state. Cleared on every render of a different
  // synthesisId because useState binds to component instance + key.
  const [expansion, setExpansion] = useState<ExpansionState | null>(null);

  // activate handler — fired by both inline chips and the consolidated
  // citations row. Toggle off if the same card+quote is clicked again,
  // else update the expansion target.
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

  return (
    <SynthesisCardActivateContext.Provider value={activate}>
      <article
        className={className}
        data-kind="synthesis"
        data-synthesis-id={synthesisId}
      >
        <span className="ai-label">AI Summary</span>
        <div className="synthesis-body" aria-live="off">
          {answer}
          {streaming && (
            <span className="synthesis-cursor" aria-hidden="true">
              ▊
            </span>
          )}
        </div>

        {!streaming && citations.length > 0 && (
          <div className="citations">{citations}</div>
        )}

        {!streaming && sources.length > 0 && (
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

// Context used by inline `<CitationChip>` nodes in `answer` to call back
// into the card's activate handler without prop-drilling through every
// React child of the streamed answer text.
import { createContext, useContext } from 'react';

type ActivateFn = (args: { rank: number; cardId: string; quote: string | undefined }) => void;
const SynthesisCardActivateContext = createContext<ActivateFn | null>(null);

/** Called from CitationChip wrappers in synthesis-stream to get the
 *  parent SynthesisCard's activate callback. Returns null when used
 *  outside a SynthesisCard (chip stays inert). */
export function useSynthesisActivate(): ActivateFn | null {
  return useContext(SynthesisCardActivateContext);
}
