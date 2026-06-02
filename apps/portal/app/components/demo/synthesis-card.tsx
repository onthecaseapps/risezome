import { Fragment, type ReactNode } from 'react';
import type { DemoSynthesis } from './types';
import { CardHeaderRow } from './card-bits';

/**
 * The AI Summary (synthesis) card, mirroring the live page's synthesis markup.
 * While `streaming`, the answer types out with a blinking cursor and the source
 * list is withheld; once done the sources appear. Citations render INLINE in
 * the answer as `[N]` chips (the live page dropped the redundant trailing
 * citation row). After the answer lands, the demo "clicks" the top source —
 * `expandedSourceId` — which expands it to reveal its snippet with the cited
 * quote highlighted, exactly like clicking a card on the live page.
 */
export function SynthesisCard({
  synthesis,
  streaming = false,
  entering = false,
}: {
  synthesis: DemoSynthesis;
  streaming?: boolean;
  entering?: boolean;
}): React.ReactElement {
  const className = ['card', 'synthesis', entering ? 'is-entering' : null]
    .filter(Boolean)
    .join(' ');

  const expandedId = synthesis.expandedSourceId ?? null;
  // The rank of the expanded source, so its inline [N] chip can light up in
  // sync — reinforcing the citation → source link.
  const activeRank =
    expandedId !== null
      ? (synthesis.sources.find((s) => s.id === expandedId)?.rank ?? null)
      : null;

  return (
    <article className={className}>
      <span className="ai-label">Summary</span>
      <div className="synthesis-body" aria-live="off">
        {renderAnswer(synthesis.text, activeRank)}
        {streaming && (
          <span className="synthesis-cursor" aria-hidden="true">
            ▊
          </span>
        )}
      </div>

      {!streaming && synthesis.sources.length > 0 && (
        <div className="synthesis-sources">
          <div className="synthesis-sources-label">Sources ({synthesis.sources.length})</div>
          <div className="synthesis-sources-list">
            {synthesis.sources.map((source) => {
              const isExpanded = source.id === expandedId;
              const cardClass = ['card', 'consolidated', isExpanded ? 'is-expanded' : null]
                .filter(Boolean)
                .join(' ');
              return (
                <article key={source.id} className={cardClass}>
                  {isExpanded && <span className="tap-ripple" aria-hidden="true" />}
                  <CardHeaderRow card={source} />
                  <div className="title">
                    <span className="title-link">{source.title}</span>
                  </div>
                  {isExpanded && (
                    <div className="source-detail">
                      <p className="detail-text">{renderSnippet(source.snippet, source.quote)}</p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

const CITE_RE = /\[(\d+)\]/g;

/** Render answer text, turning inline `[N]` markers into citation chips.
 *  The chip whose rank matches `activeRank` (the expanded source) is shown
 *  active. */
function renderAnswer(text: string, activeRank: number | null): ReactNode {
  const out: ReactNode[] = [];
  const re = new RegExp(CITE_RE.source, 'g');
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`t${key}`}>{text.slice(last, m.index)}</Fragment>);
    const rank = Number(m[1]);
    out.push(
      <span key={`c${key}`} className={`cite-inline${rank === activeRank ? ' is-active' : ''}`}>
        [{rank}]
      </span>,
    );
    last = m.index + m[0].length;
    key += 1;
  }
  if (last < text.length) out.push(<Fragment key={`t${key}`}>{text.slice(last)}</Fragment>);
  return out;
}

/** Render a snippet, wrapping the cited `quote` (case-insensitive) in a
 *  highlight mark. Falls back to plain text when there's no quote / no match. */
function renderSnippet(snippet: string, quote?: string): ReactNode {
  if (quote === undefined || quote.length === 0) return snippet;
  const i = snippet.toLowerCase().indexOf(quote.toLowerCase());
  if (i === -1) return snippet;
  return (
    <>
      {snippet.slice(0, i)}
      <mark className="hl">{snippet.slice(i, i + quote.length)}</mark>
      {snippet.slice(i + quote.length)}
    </>
  );
}
