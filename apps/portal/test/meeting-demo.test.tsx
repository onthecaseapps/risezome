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

  it('streams the transcript then goes straight to the cited AI Summary (no raw cards)', () => {
    render(<MeetingDemo />);
    const live = within(screen.getByTestId('demo-live'));

    // First transcript line fires at 250ms.
    advance(700);
    expect(live.getByText(/where are we on the auth migration/i)).toBeInTheDocument();

    // The question lands and synthesis begins (~2.3s) — but no intermediate
    // raw cards surface; the source title only shows up inside the finished
    // AI Summary, not as a standalone card during streaming.
    advance(2000);
    expect(live.getByText(/status of the auth migration PR/i)).toBeInTheDocument();
    expect(live.getByText(/Summary/i)).toBeInTheDocument();
    expect(live.queryByText('Auth migration to OAuth2 (#482)')).not.toBeInTheDocument();

    // By ~6s the synthesis has finished: AI Summary + citations + Sources grid.
    advance(4000);
    expect(live.getByText('[1]')).toBeInTheDocument();
    expect(live.getByText(/Sources \(3\)/)).toBeInTheDocument();
    expect(live.getByText('Auth migration to OAuth2 (#482)')).toBeInTheDocument();
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
