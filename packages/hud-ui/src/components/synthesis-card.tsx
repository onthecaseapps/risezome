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
import { useSynthesisActions } from '../state/synthesis-actions';

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
  /** Cards consolidated under the summary, in `sourceCardIds` order.
   *  Available during placeholder too (used for source-title line). */
  readonly sources: readonly CardEvent[];
  /** Per-occurrence citation records from the synthesis. Used by inline
   *  chip activations to look up the right quote when the chip fires
   *  onActivate. */
  readonly citationRecords?: readonly SynthesisCitation[];
  /** Pin state from the reducer. Drives the pin button glyph + ARIA
   *  label. The actual pin/unpin call goes through SynthesisActions
   *  context (host-injected). When the host doesn't provide actions
   *  the button hides. */
  readonly pinned?: boolean;
  readonly entering?: boolean;
}

interface ExpansionState {
  readonly cardId: string;
  /** Quotes to highlight in the expanded body. A single-element list when a
   *  specific [N] chip was clicked; the card's full set when the card header
   *  itself was expanded. */
  readonly quotes: readonly string[];
}

/** Distinct non-empty quotes the synthesis cited for one source card. */
function quotesForCard(
  records: readonly SynthesisCitation[] | undefined,
  cardId: string,
): readonly string[] {
  const seen = new Set<string>();
  for (const c of records ?? []) {
    if (c.cardId === cardId && c.quote !== undefined && c.quote.length > 0) seen.add(c.quote);
  }
  return [...seen];
}

export function SynthesisCard({
  synthesisId,
  phase,
  answer,
  sources,
  citationRecords,
  pinned = false,
  entering = false,
}: SynthesisCardProps): ReactElement {
  const className = [
    'card',
    'synthesis',
    `synthesis-phase-${phase}`,
    pinned ? 'is-pinned' : null,
    entering ? 'is-entering' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const synthesisActions = useSynthesisActions();

  // Per-synthesis expansion state. Cleared on every render of a different
  // synthesisId because useState binds to component instance + key.
  const [expansion, setExpansion] = useState<ExpansionState | null>(null);

  // Chip-facing activation: clicking an inline [N] chip highlights just that
  // occurrence's quote. Clicking the same card+quote again collapses.
  const activate = useCallback(
    (args: { rank: number; cardId: string; quote: string | undefined }) => {
      setExpansion((current) => {
        const quotes = args.quote !== undefined ? [args.quote] : [];
        if (
          current !== null &&
          current.cardId === args.cardId &&
          current.quotes.length === quotes.length &&
          current.quotes[0] === quotes[0]
        ) {
          return null;
        }
        return { cardId: args.cardId, quotes };
      });
    },
    [],
  );

  // Card-facing toggle: expanding the source card itself highlights ALL of
  // that card's cited quotes. Clicking an open card collapses it.
  const toggleCard = useCallback((cardId: string, quotes: readonly string[]) => {
    setExpansion((current) => (current !== null && current.cardId === cardId ? null : { cardId, quotes }));
  }, []);

  const isDone = phase === 'done';
  // The SOURCES panel and the "grounded in N" count reflect the sources the
  // model actually CITED, not every card retrieval surfaced — uncited cards
  // (often an off-topic top match) are noise here and live in the raw card
  // feed instead. sourceCardIds stays unfiltered for inline rank→cardId
  // mapping; only the displayed list is filtered.
  const citedCardIds = new Set((citationRecords ?? []).map((c) => c.cardId));
  const citedSources = sources.filter((s) => citedCardIds.has(s.cardId));
  const groundedCount = isDone ? citedSources.length : sources.length;
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
        data-pinned={pinned ? 'true' : 'false'}
        aria-busy={ariaBusy}
      >
        <div className="synthesis-header">
          <span className="ai-label">
            <SparkleGlyph />
            AI Summary
          </span>
          <span className="synthesis-grounded">
            grounded in {groundedCount} {groundedCount === 1 ? 'source' : 'sources'}
          </span>
          {phase === 'done' && (
            <PinButton
              synthesisId={synthesisId}
              pinned={pinned}
              {...(synthesisActions.pin !== undefined ? { pin: synthesisActions.pin } : {})}
              {...(synthesisActions.unpin !== undefined ? { unpin: synthesisActions.unpin } : {})}
            />
          )}
        </div>
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

        {isDone && citedSources.length > 0 && (
          <div className="synthesis-sources">
            <div className="synthesis-sources-label">
              Sources ({String(citedSources.length)})
            </div>
            <div className="synthesis-sources-list">
              {citedSources.map((source, idx) => {
                const isOpen = expansion !== null && expansion.cardId === source.cardId;
                // Expanding the card highlights ALL of its cited quotes;
                // clicking a specific [N] chip narrows to that one.
                const cardQuotes = quotesForCard(citationRecords, source.cardId);
                return (
                  <SourceCardExpanded
                    key={source.cardId}
                    source={source}
                    index={idx}
                    open={isOpen}
                    onToggle={() => toggleCard(source.cardId, cardQuotes)}
                    quotes={isOpen ? expansion.quotes : []}
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
 * Pin / unpin affordance for a completed synthesis. Hidden when the
 * host hasn't injected SynthesisActions (e.g. SSR, demo embeds).
 * Position is top-right of the card body — S9's 16px dead-zone is
 * enforced by the .pin-button class margin in styles.css so the
 * button can't sit on top of inline citation chips or the source-
 * expand chevron.
 */
function PinButton({
  synthesisId,
  pinned,
  pin,
  unpin,
}: {
  synthesisId: string;
  pinned: boolean;
  pin?: (synthesisId: string) => void | Promise<void>;
  unpin?: (synthesisId: string) => void | Promise<void>;
}): ReactElement | null {
  // If neither handler is wired, the button isn't useful — hide it.
  if (pin === undefined && unpin === undefined) return null;
  const handler = pinned ? unpin : pin;
  if (handler === undefined) return null;
  const label = pinned ? 'Unpin synthesis' : 'Pin synthesis';
  return (
    <button
      type="button"
      className="pin-button"
      aria-label={label}
      title={label}
      aria-pressed={pinned}
      onClick={() => {
        void handler(synthesisId);
      }}
    >
      {pinned ? <PinFilledGlyph /> : <PinOutlineGlyph />}
    </button>
  );
}

function SparkleGlyph(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l1.7 4.5L18 9l-4.3 1.5L12 15l-1.7-4.5L6 9l4.3-1.5z" />
      <path d="M18.5 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" opacity=".7" />
    </svg>
  );
}

function PinOutlineGlyph(): ReactElement {
  // Fill-based (not stroke) so it renders reliably — stroke-only glyphs show
  // invisibly faint in the portal, while fill glyphs (e.g. the sparkle) render.
  // Unpinned reads as "inactive" via reduced opacity + the button's muted
  // color; the pinned glyph is solid + accent-colored.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" opacity="0.65">
      <path d="M9 10.5V4h6v6.5l3 3.5v1H6v-1l3-3.5z" />
      <path d="M11.4 16h1.2v6h-1.2z" />
    </svg>
  );
}

function PinFilledGlyph(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9 10.5V4h6v6.5l3 3.5v1H6v-1l3-3.5z" />
      <path d="M11.4 16h1.2v6h-1.2z" />
    </svg>
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
