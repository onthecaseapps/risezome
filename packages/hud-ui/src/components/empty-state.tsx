'use client';

import { useEffect, useState, type ReactElement } from 'react';

/**
 * Quirky empty-state messages playing on Risezome's oceanographic theme
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

export function EmptyState(): ReactElement {
  // Start at index 0 on both server and client to guarantee a matching
  // first render. The rotation effect bumps the index after mount, so
  // by the time the user notices, we've moved past the deterministic
  // first message anyway. Previously we used `Math.random()` for the
  // initial pick, which threw a React hydration warning every time
  // the SSR pick happened to differ from the client pick.
  const [idx, setIdx] = useState<number>(0);

  useEffect(() => {
    // Kick off with a random offset on first effect tick so different
    // tabs / reloads see different starting messages — without breaking
    // SSR determinism.
    setIdx(Math.floor(Math.random() * EMPTY_STATE_MESSAGES.length));
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
