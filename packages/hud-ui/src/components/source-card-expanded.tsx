'use client';

import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import type { CardEvent, KnownSource } from '../types';
import { KNOWN_SOURCES } from '../types';
import { findQuoteInBody } from '../lib/quote-match';

/**
 * One row of a synthesis card's sources ledger ("Sources Ledger Refined"
 * design). Collapsed: a single line — citation-rank badge (cited rows) or
 * spacer (related rows), source kind pill, ellipsized title (mono for code),
 * a status label (TOP MATCH / CITED / RELATED), and a chevron. Expanded: the
 * matched-passage panel below the same line — full chunk body with optional
 * `<mark>` highlight on the LLM-emitted quotes + an "Open in {app}" link.
 *
 * Cited vs related is signaled by `rank`: a number ⇒ cited (badge shows it;
 * rank 1 reads TOP MATCH, others CITED); undefined ⇒ related — a retrieved
 * source the synthesizer marked as supporting (the ALSO: line) without
 * citing it.
 *
 * Security note (H2 from review): both the LLM-emitted quote and the
 * source body are untrusted text. The render path uses pure React text
 * nodes (`<>{before}<mark>{matched}</mark>{after}</>`) — never
 * `dangerouslySetInnerHTML`. Tests assert that `<script>` payloads
 * render as literal characters, not as DOM.
 */
export interface SourceCardExpandedProps {
  readonly source: CardEvent;
  readonly open: boolean;
  /** Verbatim quotes from the LLM citations to highlight in the body. A
   *  single quote when a specific [N] chip was clicked; all of the card's
   *  cited quotes when the row itself was expanded. Empty (or all-miss) →
   *  the body renders with no `<mark>`. */
  readonly quotes?: readonly string[];
  /** Toggle handler — clicking the row expands/collapses it, in addition
   *  to the inline `[N]` citation chips. Omitted → inert row (SSR /
   *  preview embeds). */
  readonly onToggle?: (() => void) | undefined;
  /** Citation rank for a CITED row (1-based, shown in the badge; rank 1
   *  is the TOP MATCH). Undefined ⇒ a RELATED (uncited supporting) row. */
  readonly rank?: number;
}

export function SourceCardExpanded({
  source,
  open,
  quotes,
  onToggle,
  rank,
}: SourceCardExpandedProps): ReactElement {
  const cited = rank !== undefined;
  const cls = [
    'source-card-expanded',
    open ? 'is-open' : null,
    cited && rank === 1 ? 'is-top' : null,
    cited ? null : 'is-related',
  ]
    .filter(Boolean)
    .join(' ');
  const statusLabel = !cited ? 'Related' : rank === 1 ? 'Top match' : 'Cited';

  const row = (
    <>
      {cited ? (
        <span className="source-row-badge">{rank}</span>
      ) : (
        <span className="source-row-badge-spacer" aria-hidden="true" />
      )}
      <span className={`source-row-pill ${sourceChipClass(source.source)}`}>
        {source.source.toUpperCase()}
      </span>
      <span
        className={`source-row-title${source.type === 'code' || source.type === 'tool' ? ' is-mono' : ''}`}
        title={source.title}
      >
        {source.title}
      </span>
      <span className={`source-row-status${cited ? ' is-cited' : ''}`}>{statusLabel}</span>
      <ChevronToggle />
    </>
  );

  return (
    <article className={cls} data-card-id={source.cardId} data-open={open ? 'true' : 'false'}>
      {onToggle !== undefined ? (
        <button type="button" className="source-card-toggle" onClick={onToggle} aria-expanded={open}>
          {row}
        </button>
      ) : (
        <span className="source-card-toggle is-inert">{row}</span>
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

/** Reuse the chip palette's per-source color classes for the kind pill (and
 *  the ledger header's per-source dots — they color via currentColor). */
export function sourceChipClass(source: string): string {
  const known = (KNOWN_SOURCES as readonly string[]).includes(source)
    ? (source as KnownSource)
    : 'default';
  return `chip-source-${known}`;
}

export function sourceLabel(source: string): string {
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
