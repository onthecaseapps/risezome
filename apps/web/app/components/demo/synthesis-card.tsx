import type { DemoSynthesis } from './types';
import { CardHeaderRow } from './card-bits';

/**
 * The AI Summary (synthesis) card, mirroring the HUD's synthesis markup
 * (apps/hud/src/sidebar.ts + styles.css .card.synthesis). While `streaming`,
 * the answer types out with a blinking cursor and citations/sources are
 * withheld; once done they appear - matching the real surfacing order.
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

  return (
    <article className={className}>
      <span className="ai-label">AI Summary</span>
      <div className="synthesis-body" aria-live="off">
        {synthesis.text}
        {streaming && (
          <span className="synthesis-cursor" aria-hidden="true">
            ▊
          </span>
        )}
      </div>

      {!streaming && synthesis.citations.length > 0 && (
        <div className="citations">
          {synthesis.citations.map((rank) => (
            <span key={rank} className="citation-chip">
              [{rank}]
            </span>
          ))}
        </div>
      )}

      {!streaming && synthesis.sources.length > 0 && (
        <div className="synthesis-sources">
          <div className="synthesis-sources-label">Sources ({synthesis.sources.length})</div>
          <div className="synthesis-sources-grid">
            {synthesis.sources.map((source) => (
              <article key={source.id} className="card consolidated">
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
