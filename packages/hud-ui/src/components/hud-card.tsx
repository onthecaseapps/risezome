'use client';

import { useState, useTransition, type ReactElement } from 'react';
import type { CardEvent } from '../types';
import { CardHeaderRow } from './card-bits';
import { PinGlyph } from './glyphs';
import { useCardActions } from '../state/card-actions';

/**
 * A faithful RAG context card, mirroring the HUD's raw card markup
 * (apps/hud/src/sidebar.ts buildCard + styles.css .card). Pure presentation
 * for the body; the action row reads CardActionsContext so the host app
 * can supply pin/dismiss handlers (the portal's live page does; hud-next
 * leaves the context empty and the Pin button stays as a static no-op
 * for visual completeness).
 *
 * `data-card-id` on the root `<article>` is load-bearing — the polish-plan
 * U5 citation-chip click-to-scroll uses `article[data-card-id="..."]`
 * as its selector.
 */
export function HudCard({
  card,
  entering = false,
  pinned = false,
}: {
  card: CardEvent;
  entering?: boolean;
  pinned?: boolean;
}): ReactElement {
  const actions = useCardActions();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const classes = ['card'];
  if (entering) classes.push('is-entering');
  if (pinned) classes.push('pinned');

  function handlePin(): void {
    if (actions.pin === undefined) return;
    setError(null);
    startTransition(async () => {
      try {
        await actions.pin!(card.cardId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      }
    });
  }
  function handleUnpin(): void {
    if (actions.unpin === undefined) return;
    setError(null);
    startTransition(async () => {
      try {
        await actions.unpin!(card.cardId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      }
    });
  }
  function handleDismiss(): void {
    if (actions.dismiss === undefined) return;
    setError(null);
    startTransition(async () => {
      try {
        await actions.dismiss!(card.cardId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      }
    });
  }

  return (
    <article className={classes.join(' ')} data-card-id={card.cardId}>
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
        {pinned && actions.unpin !== undefined ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Unpin ${card.title}`}
            onClick={handleUnpin}
            disabled={pending}
          >
            <PinGlyph />
            Unpin
          </button>
        ) : !pinned && actions.pin !== undefined ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Pin ${card.title}`}
            onClick={handlePin}
            disabled={pending}
          >
            <PinGlyph />
            Pin
          </button>
        ) : (
          // Pre-roundtrip-wiring HUDs (hud-next) still show the static
          // Pin button so the demo card looks complete.
          <button type="button" className="icon-btn" aria-label={`Pin ${card.title}`}>
            <PinGlyph />
            Pin
          </button>
        )}
        {actions.dismiss !== undefined ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Dismiss ${card.title}`}
            onClick={handleDismiss}
            disabled={pending}
          >
            Dismiss
          </button>
        ) : null}
        {error !== null ? <span className="card-action-error">{error}</span> : null}
      </div>
    </article>
  );
}
