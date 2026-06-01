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
  /** Verbatim quotes from the LLM citations to highlight in the body. A
   *  single quote when a specific [N] chip was clicked; all of the card's
   *  cited quotes when the card itself was expanded. Empty (or all-miss) →
   *  the body renders with no `<mark>`. */
  readonly quotes?: readonly string[];
  /** Toggle handler — clicking the card header expands/collapses it,
   *  in addition to the inline `[N]` citation chips. Omitted → inert
   *  header (SSR / preview embeds). */
  readonly onToggle?: (() => void) | undefined;
  /** 0-based position in the source list; rendered as the `[N]` badge
   *  next to the title (matches the inline citation number). */
  readonly index?: number;
}

export function SourceCardExpanded({
  source,
  open,
  quotes,
  onToggle,
  index,
}: SourceCardExpandedProps): ReactElement {
  const cls = ['source-card-expanded', open ? 'is-open' : null, source.rank === 1 ? 'is-top' : null]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      <span className="source-card-header-row">
        <CardHeaderRow card={source} />
        <ChevronToggle />
      </span>
      <span className="source-card-title">
        {index !== undefined ? <span className="source-card-index">{index + 1}</span> : null}
        <span className="title-link">{source.title}</span>
      </span>
      {!open && source.snippet.length > 0 ? (
        <span className="source-card-snippet">{source.snippet}</span>
      ) : null}
    </>
  );

  return (
    <article className={cls} data-card-id={source.cardId} data-open={open ? 'true' : 'false'}>
      {onToggle !== undefined ? (
        <button type="button" className="source-card-toggle" onClick={onToggle} aria-expanded={open}>
          {inner}
        </button>
      ) : (
        inner
      )}
      {open && (
        <div className="source-card-passage">
          <div className="source-card-passage-label">
            <span className="source-card-passage-dot" aria-hidden="true" />
            Matched passage
          </div>
          <ExpandedBody source={source} quotes={quotes ?? []} />
          {source.url !== undefined && source.url.length > 0 ? (
            <div className="source-card-footer">
              <a
                className="source-card-open"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                Open in {sourceLabel(source.source)}
                <OpenIcon />
              </a>
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}

function sourceLabel(source: string): string {
  return source.length === 0 ? 'source' : source.charAt(0).toUpperCase() + source.slice(1);
}

function ChevronToggle(): ReactElement {
  return (
    <svg
      className="source-card-chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function OpenIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  );
}

function ExpandedBody({
  source,
  quotes,
}: {
  source: CardEvent;
  quotes: readonly string[];
}): ReactElement {
  const body = source.body ?? source.snippet;
  // Stable dep: re-find only when the set of quotes or the body changes.
  const quotesKey = quotes.join('\u0000');
  const matches = useMemo(() => {
    const qs = quotesKey.length > 0 ? quotesKey.split('\u0000') : [];
    const found: { index: number; length: number }[] = [];
    for (const q of qs) {
      const m = findQuoteInBody(q, body);
      if (m !== null) found.push(m);
    }
    // Order by position and drop overlaps so the segment walk is monotonic
    // (two quotes can resolve to overlapping spans in the same body).
    found.sort((a, b) => a.index - b.index);
    const merged: { index: number; length: number }[] = [];
    let lastEnd = -1;
    for (const m of found) {
      if (m.index >= lastEnd) {
        merged.push(m);
        lastEnd = m.index + m.length;
      }
    }
    return merged;
  }, [quotesKey, body]);
  const firstMarkRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (matches.length === 0 || firstMarkRef.current === null) return;
    // Scroll the first highlight to roughly mid-viewport so the user lands
    // on the matched region; smooth so the move reads as intentional.
    firstMarkRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [matches]);

  let segments: ReactNode = body;
  if (matches.length > 0) {
    const parts: ReactNode[] = [];
    let pos = 0;
    matches.forEach((m, i) => {
      if (m.index > pos) parts.push(body.slice(pos, m.index));
      parts.push(
        <mark
          key={`mark-${String(i)}`}
          {...(i === 0 ? { ref: firstMarkRef } : {})}
          className="quote-highlight"
        >
          {body.slice(m.index, m.index + m.length)}
        </mark>,
      );
      pos = m.index + m.length;
    });
    if (pos < body.length) parts.push(body.slice(pos));
    segments = <>{parts}</>;
  }

  return (
    <div className="source-body" data-has-highlight={matches.length > 0 ? 'true' : 'false'}>
      {segments}
    </div>
  );
}
