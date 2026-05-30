import type { ReactElement } from 'react';
import type { CardEvent } from '../types';
import { CardHeaderRow } from './card-bits';
import { PinGlyph } from './glyphs';

/**
 * A faithful RAG context card, mirroring the HUD's raw card markup
 * (apps/hud/src/sidebar.ts buildCard + styles.css .card). Pure presentation;
 * U3 manages the `entering` flag via the reducer to mount the slide-in.
 *
 * **Modified from the demo:** the root `<article>` element carries
 * `data-card-id={card.cardId}`. The polish-plan U5 citation-chip
 * click-to-scroll uses `article[data-card-id="..."]` as its selector; the
 * demo's HudCard omitted this attribute. Without it, click-to-scroll
 * silently fails (querySelector returns null).
 */
export function HudCard({
  card,
  entering = false,
}: {
  card: CardEvent;
  entering?: boolean;
}): ReactElement {
  return (
    <article className={entering ? 'card is-entering' : 'card'} data-card-id={card.cardId}>
      <CardHeaderRow card={card} />
      <div className="title">
        {typeof card.url === 'string' && card.url.length > 0 ? (
          <a className="title-link" href={card.url} target="_blank" rel="noopener noreferrer">
            {card.title}
          </a>
        ) : (
          <span className="title-link">{card.title}</span>
        )}
      </div>
      <div className="snippet">{card.snippet}</div>
      <div className="actions">
        <button type="button" className="icon-btn" aria-label={`Pin ${card.title}`}>
          <PinGlyph />
          Pin
        </button>
      </div>
    </article>
  );
}
