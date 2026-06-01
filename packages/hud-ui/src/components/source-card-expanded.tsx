'use client';

import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import type { CardEvent } from '../types';
import { CardHeaderRow } from './card-bits';
import { findQuoteInBody } from '../lib/quote-match';

/**
 * Inline-expandable source card rendered beneath a SynthesisCard's
 * answer. When `open` is false, just the collapsed header (source pill,
 * title) renders. When `open` is true, the full chunk body is shown.
 *
 * If `quote` is provided AND a match for it is found in the body
 * (via findQuoteInBody — raw indexOf with a whitespace-normalized
 * fallback per S5), the matching span is wrapped in `<mark>` and
 * scrolled into view via a ref. Re-rendering with a different quote
 * updates the highlight position in place — same component instance,
 * effect re-fires on quote change.
 *
 * Security note (H2 from review): both the LLM-emitted quote and the
 * source body are untrusted text. The render path uses pure React text
 * nodes (`<>{before}<mark>{matched}</mark>{after}</>`) — never
 * `dangerouslySetInnerHTML`. Tests assert that `<script>` payloads
 * render as literal characters, not as DOM.
 *
 * Retracted source: when the parent passes `open=true` for a card that
 * doesn't exist (synthesis citing a card that's since been retracted —
 * pinned-synthesis preservation per S2), render a "source no longer
 * available" marker instead of body content. The card's id is the
 * caller's signal: this component just renders whatever `source` it
 * gets; the parent decides what to pass.
 */
export interface SourceCardExpandedProps {
  readonly source: CardEvent;
  readonly open: boolean;
  /** Verbatim quote from the LLM citation. Undefined when the parser
   *  fell back to bare [N] (no quote payload); the source still
   *  expands but no `<mark>` renders. */
  readonly quote?: string;
  /** Toggle handler — clicking the card header expands/collapses it,
   *  in addition to the inline `[N]` citation chips. Omitted → inert
   *  header (SSR / preview embeds). */
  readonly onToggle?: (() => void) | undefined;
}

export function SourceCardExpanded({
  source,
  open,
  quote,
  onToggle,
}: SourceCardExpandedProps): ReactElement {
  const header = (
    <span className="source-card-head">
      <CardHeaderRow card={source} />
      <span className="title">
        <span className="title-link">{source.title}</span>
      </span>
    </span>
  );

  return (
    <article
      className={open ? 'source-card-expanded is-open' : 'source-card-expanded'}
      data-card-id={source.cardId}
      data-open={open ? 'true' : 'false'}
    >
      {onToggle !== undefined ? (
        <button type="button" className="source-card-toggle" onClick={onToggle} aria-expanded={open}>
          {header}
          <ChevronToggle />
        </button>
      ) : (
        header
      )}
      {open && <ExpandedBody source={source} quote={quote} />}
    </article>
  );
}

function ChevronToggle(): ReactElement {
  return (
    <svg
      className="source-card-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ExpandedBody({
  source,
  quote,
}: {
  source: CardEvent;
  quote: string | undefined;
}): ReactElement {
  const body = source.body ?? source.snippet;
  const match = useMemo(() => findQuoteInBody(quote, body), [quote, body]);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (match === null || markRef.current === null) return;
    // scrollIntoView 'center' so the highlighted span lands roughly mid-
    // viewport. smooth so the move is visible without being jarring.
    markRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [match, quote]);

  const segments: ReactNode = match === null
    ? body
    : (
      <>
        {body.slice(0, match.index)}
        <mark ref={markRef} className="quote-highlight">
          {body.slice(match.index, match.index + match.length)}
        </mark>
        {body.slice(match.index + match.length)}
      </>
    );

  return (
    <div
      className="source-body"
      data-has-highlight={match !== null ? 'true' : 'false'}
    >
      {segments}
    </div>
  );
}
