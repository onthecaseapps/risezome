'use client';

import { type ReactElement } from 'react';
import { useAppState } from '../state/app-state';
import { ThemeToggle } from './theme-toggle';
import { PinnedSection } from './pinned-section';
import { CardStream } from './card-stream';
import { SynthesisStream } from './synthesis-stream';
import { SynthesisAnnounce } from './synthesis-announce';

/**
 * Top-level HUD layout. Mirrors apps/hud/index.html region-for-region:
 *
 * - `<main id="app">`
 *   - `<header id="hud-header">` — meeting status pill, connection banner, theme toggle
 *   - `<section id="pinned-section">` — pinned cards
 *   - `<section id="card-stream">` — synthesis-stream above the newest-first card stream
 *   - `<div id="synthesis-announce">` — sr-only aria-live region for SR announcements
 *
 * The new-content-badge from the production HUD is intentionally deferred
 * — the hover-safe scroll behavior depends on real scroll-container plumbing
 * that doesn't survive happy-dom; landing it in a follow-up keeps U4 shippable.
 */
export function HudShell(): ReactElement {
  const state = useAppState();
  const isLive = state.meeting === 'live';

  let bannerText = '';
  let bannerHidden = true;
  if (state.status === 'connecting') {
    bannerText = 'Connecting…';
    bannerHidden = false;
  } else if (state.status === 'disconnected') {
    bannerText = 'Disconnected. Reconnecting…';
    bannerHidden = false;
  }

  return (
    <main id="app">
      <header id="hud-header">
        <span
          id="meeting-status"
          className={`status ${isLive ? 'status-live' : 'status-idle'}`}
          aria-live="polite"
        >
          {isLive ? 'LIVE' : 'IDLE'}
        </span>
        <span id="meeting-label" />
        <span
          id="connection-banner"
          className={bannerHidden ? 'hidden' : ''}
          role="status"
        >
          {bannerText}
        </span>
        <ThemeToggle />
      </header>
      <PinnedSection />
      <SynthesisStream />
      <CardStream />
      <SynthesisAnnounce text={state.lastSynthesisAnnounce} />
    </main>
  );
}
