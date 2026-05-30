'use client';

import { useEffect, useState, type ReactElement } from 'react';

/**
 * Quirky empty-state messages playing on Upwell's oceanographic theme
 * (upwelling = deep water rising to the surface). 10-second rotation
 * keeps the HUD feeling alive during quiet stretches without becoming
 * distracting.
 *
 * Ported verbatim from apps/hud/src/sidebar.ts EMPTY_STATE_MESSAGES.
 */
export const EMPTY_STATE_MESSAGES: readonly string[] = [
  'Waiting for some swell information to surface.',
  'Preparing to propel pertinent payloads.',
  'Listening for ripples in the conversation.',
  'Casting nets across your repos.',
  'Calm currents. Awaiting your voice.',
  'Polling the depths of your corpus.',
  'Riding the swell, awaiting landfall.',
  'Sieving signal from the chatter.',
  'Idle waters run deep. Speak to fathom them.',
  'Buoys are bobbing, results incoming.',
  'Calibrating the conversational compass.',
  'Sharpening the synthesizer’s edges.',
  'Beachcombing the corpus while you think.',
  'Hush mode engaged. The HUD listens.',
];

function pickInitial(): number {
  return Math.floor(Math.random() * EMPTY_STATE_MESSAGES.length);
}

export function EmptyState(): ReactElement {
  const [idx, setIdx] = useState<number>(pickInitial);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIdx((prev) => {
        if (EMPTY_STATE_MESSAGES.length <= 1) return prev;
        let next = Math.floor(Math.random() * EMPTY_STATE_MESSAGES.length);
        if (next === prev) next = (next + 1) % EMPTY_STATE_MESSAGES.length;
        return next;
      });
    }, 10_000);
    return (): void => {
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="empty-state">
      <span className="empty-state-msg">{EMPTY_STATE_MESSAGES[idx] ?? ''}</span>
    </div>
  );
}
