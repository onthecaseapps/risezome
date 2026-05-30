import type { DemoCard } from './types';
import { CardHeaderRow } from './card-bits';
import { PinGlyph } from './glyphs';

/**
 * A faithful RAG context card, mirroring the HUD's raw card markup
 * (apps/hud/src/sidebar.ts buildCard + styles.css .card). Pure presentation;
 * U6 toggles `entering` to mount the slide-in animation.
 */
export function HudCard({
  card,
  entering = false,
}: {
  card: DemoCard;
  entering?: boolean;
}): React.ReactElement {
  return (
    <article className={entering ? 'card is-entering' : 'card'}>
      <CardHeaderRow card={card} />
      <div className="title">
        <span className="title-link">{card.title}</span>
      </div>
      {card.docHeading !== undefined && <div className="doc-heading">{card.docHeading}</div>}
      <div className="snippet">{card.snippet}</div>
      {card.meta !== undefined && <div className="meta">{card.meta}</div>}
      <div className="actions">
        <button type="button" className="icon-btn" tabIndex={-1} aria-label={`Pin ${card.title}`}>
          <PinGlyph />
          Pin
        </button>
      </div>
    </article>
  );
}
