import type { ReactElement, ReactNode } from 'react';
import type { CardEvent } from '../types';
import { CardHeaderRow } from './card-bits';

/**
 * AI Summary (synthesis) card. Pure presentation. While `streaming`, the
 * answer types out with a blinking cursor and citation chips/source-grid
 * are withheld; once done they appear.
 *
 * **Note on citation chips:** the chips rendered inline in `answer` (where
 * `[N]` tokens appear) are interactive `<CitationChip>` components built
 * in U4 — NOT the demo's inert `<span>[N]</span>`. Pass them in as `answer`
 * children pre-rendered by the parent. This component is presentation-only.
 *
 * **Note on consolidated sources:** the source articles below the summary
 * carry `data-card-id` so the citation chips' click-to-scroll selector
 * resolves correctly when scrolling between AI Summary and the source.
 */
export function SynthesisCard({
  synthesisId,
  answer,
  citations,
  sources,
  streaming = false,
  entering = false,
}: {
  synthesisId: string;
  /** Pre-rendered answer text; may include <CitationChip> nodes. */
  answer: ReactNode;
  /** Final citation chip nodes shown beneath the answer. */
  citations: ReactNode[];
  /** Cards consolidated under the summary. */
  sources: readonly CardEvent[];
  streaming?: boolean;
  entering?: boolean;
}): ReactElement {
  const className = ['card', 'synthesis', entering ? 'is-entering' : null]
    .filter(Boolean)
    .join(' ');

  return (
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
          <div className="synthesis-sources-label">Sources ({sources.length})</div>
          <div className="synthesis-sources-grid">
            {sources.map((source) => (
              <article
                key={source.cardId}
                className="card consolidated"
                data-card-id={source.cardId}
              >
                <CardHeaderRow card={source} />
                <div className="title">
                  <span className="title-link">{source.title}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
