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
import { SourceCardExpanded, sourceChipClass, sourceLabel } from './source-card-expanded';
import { PinGlyph } from './glyphs';
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
  /** Cards the synthesizer marked as also supporting the answer without
   *  citing them (the ALSO: line), already resolved by the caller. Rendered
   *  as RELATED rows in the sources ledger; omitted when empty. */
  readonly additionalSources?: readonly CardEvent[];
  /** Pin state from the reducer. Drives the pin button glyph + ARIA
   *  label. The actual pin/unpin call goes through SynthesisActions
   *  context (host-injected). When the host doesn't provide actions
   *  the button hides. */
  readonly pinned?: boolean;
  readonly entering?: boolean;
  /** The question (triggering utterance) that produced this answer. When
   *  provided, renders above the answer card. Resolved by the caller from
   *  the synthesis's triggerUtteranceId + the transcript. */
  readonly question?: string;
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
  additionalSources = [],
  pinned = false,
  entering = false,
  question,
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

  // Per-synthesis ledger state ("Sources Ledger Refined" design): the whole
  // ledger collapses to one line by default; each row's passage opens
  // independently, keyed by cardId with the quote set to highlight. Cleared
  // on every render of a different synthesisId because useState binds to
  // component instance + key.
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [openRows, setOpenRows] = useState<ReadonlyMap<string, readonly string[]>>(new Map());

  // Chip-facing activation: clicking an inline [N] chip expands the ledger
  // and opens the cited row at that occurrence's quote. Clicking the same
  // chip again (with the ledger already open) collapses the row.
  const activate = useCallback(
    (args: { rank: number; cardId: string; quote: string | undefined }) => {
      const quotes = args.quote !== undefined ? [args.quote] : [];
      setOpenRows((current) => {
        const existing = current.get(args.cardId);
        const same =
          existing?.length === quotes.length && existing[0] === quotes[0];
        const next = new Map(current);
        if (ledgerOpen && same) next.delete(args.cardId);
        else next.set(args.cardId, quotes);
        return next;
      });
      setLedgerOpen(true);
    },
    [ledgerOpen],
  );

  // Row-facing toggle: expanding a row itself highlights ALL of that card's
  // cited quotes (none for a related row). Clicking an open row collapses it.
  const toggleRow = useCallback((cardId: string, quotes: readonly string[]) => {
    setOpenRows((current) => {
      const next = new Map(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.set(cardId, quotes);
      return next;
    });
  }, []);

  const isDone = phase === 'done';
  // The ledger and the "grounded in" count reflect the sources the model
  // actually USED: cited rows (in the answer) + related rows (retrieved-but-
  // uncited sources the synthesizer marked as supporting via the ALSO: line).
  // Other retrieved cards are noise here and live in the raw card feed.
  // sourceCardIds stays unfiltered for inline rank→cardId mapping.
  const citedCardIds = new Set((citationRecords ?? []).map((c) => c.cardId));
  const citedSources = sources.filter((s) => citedCardIds.has(s.cardId));
  // Defensive dedupe: a related card that somehow also got cited renders once,
  // as cited.
  const relatedSources = additionalSources.filter((s) => !citedCardIds.has(s.cardId));
  const ariaBusy = phase !== 'done';
  // Stream phase reads politely so SRs follow along; placeholder is
  // intentionally silent (the shimmer means nothing to announce).
  const ariaLive: 'off' | 'polite' = phase === 'streaming' ? 'polite' : 'off';

  return (
    <SynthesisCardActivateContext.Provider value={activate}>
      {/* Card + sources are one logical unit but two visual blocks: the answer
          lives in the `.card.synthesis` <article>, the cited sources sit
          OUTSIDE it as a sibling <section> below. Both stay under the activate
          provider + this component's expansion state, so clicking an inline
          [N] chip in the answer still highlights its source below. */}
      <div className="synthesis-block">
        {question !== undefined && question.length > 0 && (
          <header className="synthesis-question">
            <SparkleGlyph />
            <span className="synthesis-question-text">{question}</span>
          </header>
        )}
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
              Summary
            </span>
            <span className="synthesis-grounded">
              {isDone ? (
                <>
                  grounded in {citedSources.length} cited
                  {relatedSources.length > 0 && <> · {relatedSources.length} related</>}
                </>
              ) : (
                <>
                  grounded in {sources.length} {sources.length === 1 ? 'source' : 'sources'}
                </>
              )}
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
        </article>

        {isDone && (citedSources.length > 0 || relatedSources.length > 0) && (
          <SourcesLedger
            cited={citedSources}
            related={relatedSources}
            citationRecords={citationRecords}
            open={ledgerOpen}
            onToggleOpen={() => setLedgerOpen((o) => !o)}
            openRows={openRows}
            onToggleRow={toggleRow}
            onSetAllRows={setOpenRows}
          />
        )}
      </div>
    </SynthesisCardActivateContext.Provider>
  );
}

/**
 * The sources ledger ("Sources Ledger Refined" design): one collapsed line
 * per synthesis — "Grounded in N cited + M related sources" with per-source
 * colored dots (related dots dimmed) and the distinct app names — expanding
 * into unified rows for cited and related sources, each with its own
 * matched-passage panel. An "Expand all passages" shortcut opens every row
 * at once (cited rows highlight their full quote sets).
 */
function SourcesLedger({
  cited,
  related,
  citationRecords,
  open,
  onToggleOpen,
  openRows,
  onToggleRow,
  onSetAllRows,
}: {
  cited: readonly CardEvent[];
  related: readonly CardEvent[];
  citationRecords: readonly SynthesisCitation[] | undefined;
  open: boolean;
  onToggleOpen: () => void;
  openRows: ReadonlyMap<string, readonly string[]>;
  onToggleRow: (cardId: string, quotes: readonly string[]) => void;
  onSetAllRows: (rows: ReadonlyMap<string, readonly string[]>) => void;
}): ReactElement {
  // First citation rank per cited card — the row badge (rank 1 = TOP MATCH).
  const rankByCard = new Map<string, number>();
  for (const c of citationRecords ?? []) {
    const existing = rankByCard.get(c.cardId);
    if (existing === undefined || c.rank < existing) rankByCard.set(c.cardId, c.rank);
  }
  const rows: { card: CardEvent; rank?: number }[] = [
    ...cited.map((card) => {
      const rank = rankByCard.get(card.cardId);
      return rank !== undefined ? { card, rank } : { card };
    }),
    ...related.map((card) => ({ card })),
  ];
  const total = cited.length + related.length;
  const apps = [...new Set(rows.map(({ card }) => sourceLabel(card.source)))];
  const allOpen = rows.every(({ card }) => openRows.has(card.cardId));

  const quotesFor = (row: { card: CardEvent; rank?: number }): readonly string[] =>
    row.rank !== undefined ? quotesForCard(citationRecords, row.card.cardId) : [];

  const toggleAll = (): void => {
    onSetAllRows(allOpen ? new Map() : new Map(rows.map((row) => [row.card.cardId, quotesFor(row)])));
  };

  return (
    <section className="synthesis-ledger" aria-label="Sources" data-open={open ? 'true' : 'false'}>
      <div className="ledger-header">
        <button type="button" className="ledger-toggle" aria-expanded={open} onClick={onToggleOpen}>
          <LedgerChevron open={open} />
          <span className="ledger-summary">
            Grounded in <strong>{cited.length} cited</strong>
            {related.length > 0 && (
              <>
                {' '}
                + <strong>{related.length} related</strong>
              </>
            )}{' '}
            {total === 1 ? 'source' : 'sources'}
          </span>
          {!open && apps.length > 0 && <span className="ledger-apps">· {apps.join(' · ')}</span>}
          <span className="ledger-dots" aria-hidden="true">
            {rows.map(({ card, rank }) => (
              <span
                key={card.cardId}
                className={`ledger-dot ${sourceChipClass(card.source)}${rank === undefined ? ' is-related' : ''}`}
              />
            ))}
          </span>
        </button>
        {open && (
          <button type="button" className="ledger-expand-all" onClick={toggleAll}>
            {allOpen ? 'Collapse all passages' : 'Expand all passages'}
          </button>
        )}
      </div>
      {open && (
        <div className="ledger-rows">
          {rows.map((row) => (
            <SourceCardExpanded
              key={row.card.cardId}
              source={row.card}
              open={openRows.has(row.card.cardId)}
              quotes={openRows.get(row.card.cardId) ?? []}
              onToggle={() => onToggleRow(row.card.cardId, quotesFor(row))}
              {...(row.rank !== undefined ? { rank: row.rank } : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LedgerChevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      className={`ledger-chevron${open ? ' is-open' : ''}`}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
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
      {/* Same thumbtack glyph the card pin action uses; pinned state reads
          through the button's aria-pressed accent color. */}
      <PinGlyph />
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
