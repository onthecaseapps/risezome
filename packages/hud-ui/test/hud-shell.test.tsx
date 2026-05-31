import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { HudShell } from '../src/components/hud-shell.js';
import { AppStateProvider, initialAppState } from '../src/state/app-state.js';
import type { CardEvent } from '../src/types.js';

function mkCard(over: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'c',
    docId: 'd',
    source: 'github',
    type: 'issue',
    title: 'T',
    snippet: 's',
    score: 0.9,
    rank: 1,
    metadata: {},
    surfacedAt: 0,
    triggeredBy: 'window',
    traceId: 't',
    ...over,
  };
}

describe('HudShell', () => {
  it('contains every region from the production HUD DOM inventory', () => {
    const { container } = render(
      <AppStateProvider initial={initialAppState}>
        <HudShell />
      </AppStateProvider>,
    );
    expect(container.querySelector('main#app')).not.toBeNull();
    expect(container.querySelector('header#hud-header')).not.toBeNull();
    expect(container.querySelector('#meeting-status')).not.toBeNull();
    expect(container.querySelector('#connection-banner')).not.toBeNull();
    expect(container.querySelector('#theme-toggle')).not.toBeNull();
    expect(container.querySelector('#pinned-section')).not.toBeNull();
    expect(container.querySelector('#card-stream')).not.toBeNull();
    expect(container.querySelector('#synthesis-announce')).not.toBeNull();
  });

  it('meeting status pill renders IDLE when meeting is idle', () => {
    const { container } = render(
      <AppStateProvider initial={initialAppState}>
        <HudShell />
      </AppStateProvider>,
    );
    const pill = container.querySelector('#meeting-status');
    expect(pill?.textContent).toBe('IDLE');
    expect(pill?.classList.contains('status-idle')).toBe(true);
  });

  it('meeting status pill renders LIVE when meeting is live', () => {
    const { container } = render(
      <AppStateProvider initial={{ ...initialAppState, meeting: 'live' }}>
        <HudShell />
      </AppStateProvider>,
    );
    const pill = container.querySelector('#meeting-status');
    expect(pill?.textContent).toBe('LIVE');
    expect(pill?.classList.contains('status-live')).toBe(true);
  });

  it('hides connection banner when WS is open', () => {
    const { container } = render(
      <AppStateProvider initial={{ ...initialAppState, status: 'open' }}>
        <HudShell />
      </AppStateProvider>,
    );
    const banner = container.querySelector('#connection-banner');
    expect(banner?.classList.contains('hidden')).toBe(true);
  });

  it('shows Connecting… when WS is connecting', () => {
    const { container } = render(
      <AppStateProvider initial={{ ...initialAppState, status: 'connecting' }}>
        <HudShell />
      </AppStateProvider>,
    );
    const banner = container.querySelector('#connection-banner');
    expect(banner?.classList.contains('hidden')).toBe(false);
    expect(banner?.textContent).toContain('Connecting');
  });

  it('shows Disconnected. Reconnecting… when WS is disconnected', () => {
    const { container } = render(
      <AppStateProvider initial={{ ...initialAppState, status: 'disconnected' }}>
        <HudShell />
      </AppStateProvider>,
    );
    const banner = container.querySelector('#connection-banner');
    expect(banner?.textContent).toContain('Disconnected');
  });

  it('renders pinned and stream cards into separate sections', () => {
    const cards = new Map([
      ['a', { card: mkCard({ cardId: 'a', title: 'Pinned' }), pinned: true }],
      ['b', { card: mkCard({ cardId: 'b', title: 'Streamed' }), pinned: false }],
    ]);
    const { container } = render(
      <AppStateProvider initial={{ ...initialAppState, cards }}>
        <HudShell />
      </AppStateProvider>,
    );
    expect(
      container.querySelector('#pinned-section article[data-card-id="a"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('#card-stream article[data-card-id="b"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('#card-stream article[data-card-id="a"]'),
    ).toBeNull();
  });
});
