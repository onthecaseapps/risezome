import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import { MeetingDemo } from '../app/components/demo/meeting-demo';
import { TIMELINE_DURATION_MS } from '../app/components/demo/demo-timeline';

/**
 * Drives the demo's requestAnimationFrame clock manually so we can assert the
 * scene actually advances over time — the regression that left the transcript
 * stuck empty when playback was gated on the IntersectionObserver.
 */
let rafCallbacks: FrameRequestCallback[] = [];
let clock = 0;

function flushFrame(stepMs: number): void {
  clock += stepMs;
  const due = rafCallbacks;
  rafCallbacks = [];
  act(() => {
    for (const cb of due) cb(clock);
  });
}

function advance(totalMs: number, stepMs = 50): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) flushFrame(stepMs);
}

beforeEach(() => {
  rafCallbacks = [];
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined);
  // jsdom has no matchMedia; report "motion allowed" so the animated path runs.
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
        dispatchEvent: (): boolean => false,
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MeetingDemo playback', () => {
  // The demo renders an invisible terminal-state "sizer" (to reserve height and
  // prevent layout shift) plus the live animated layer. Both carry the same
  // text, so scope assertions to the live layer (data-testid="demo-live").
  it('renders the LIVE header and an empty transcript before time advances', () => {
    render(<MeetingDemo />);
    const live = within(screen.getByTestId('demo-live'));
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(live.getByText('Transcript')).toBeInTheDocument();
    expect(live.queryByText(/Priya:/)).not.toBeInTheDocument();
  });

  it('streams the AI Summary, then auto-expands the top source with a highlighted quote', () => {
    render(<MeetingDemo />);
    const live = within(screen.getByTestId('demo-live'));

    // First transcript line fires at 250ms.
    advance(700);
    expect(live.getByText(/where are we on the auth migration/i)).toBeInTheDocument();

    // The question lands and synthesis begins (~2.3s) — but no intermediate
    // raw cards surface; the source title only shows up inside the finished
    // AI Summary, not as a standalone card during streaming.
    advance(2000); // ~2.7s
    expect(live.getByText(/Summary/i)).toBeInTheDocument();
    expect(live.queryByText('Auth migration to OAuth2 (#482)')).not.toBeInTheDocument();

    // By ~6s the synthesis has finished: citations render INLINE (no trailing
    // chip row) and the Sources list shows, but the cards are still collapsed
    // (titles only — the snippet/quote isn't revealed yet).
    advance(3300); // ~6.0s (synthesisDone at 5.5s, expand at 6.6s)
    expect(live.getByText('[1]')).toBeInTheDocument();
    expect(live.getByText(/Sources \(3\)/)).toBeInTheDocument();
    expect(live.getByText('Auth migration to OAuth2 (#482)')).toBeInTheDocument();
    expect(
      live.queryByText('Swaps the legacy session cookies for OAuth2 bearer tokens'),
    ).not.toBeInTheDocument();

    // ~7s: the top source auto-expands, revealing its snippet with the cited
    // quote highlighted.
    advance(1000); // ~7.0s
    expect(
      live.getByText('Swaps the legacy session cookies for OAuth2 bearer tokens'),
    ).toBeInTheDocument();
  });

  it('captions each pipeline step at the bottom of the demo', () => {
    render(<MeetingDemo />);

    advance(700); // transcript streaming, no synthesis yet
    expect(screen.getByText('Transcribing Meeting')).toBeInTheDocument();

    advance(2000); // ~2.7s — synthesis started, no text yet (retrieving)
    expect(screen.getByText('Gathering Context')).toBeInTheDocument();

    advance(1100); // ~3.8s — answer text streaming
    expect(screen.getByText('Synthesizing Answer')).toBeInTheDocument();

    advance(3500); // ~7.3s — top source expanded, citation highlighted
    expect(screen.getByText('Viewing Source Citation')).toBeInTheDocument();
  });

  it('loops back to an empty scene after the end-hold', () => {
    render(<MeetingDemo />);
    const live = within(screen.getByTestId('demo-live'));
    advance(11000);
    expect(live.getByText(/Summary/i)).toBeInTheDocument();

    // Land just past the loop boundary but before the first event (300ms) of
    // the new cycle: the scene is reset and empty again.
    advance(TIMELINE_DURATION_MS - 11000 + 150);
    expect(live.queryByText(/Summary/i)).not.toBeInTheDocument();
    expect(live.queryByText(/where are we on the auth migration/i)).not.toBeInTheDocument();
  });
});
