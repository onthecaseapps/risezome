import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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
  it('renders the LIVE header and an empty transcript before time advances', () => {
    render(<MeetingDemo />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.queryByText(/Priya:/)).not.toBeInTheDocument();
  });

  it('streams transcript lines, surfaces cards, then types the cited AI Summary', () => {
    render(<MeetingDemo />);

    // First transcript line fires at 300ms.
    advance(700);
    expect(screen.getByText(/where are we on the auth migration/i)).toBeInTheDocument();

    // The detected question and the surfaced RAG cards arrive by ~6s.
    advance(6000);
    expect(screen.getByText(/status of the auth migration PR/i)).toBeInTheDocument();
    expect(screen.getByText('Auth migration to OAuth2 (#482)')).toBeInTheDocument();

    // By ~11s the synthesis has finished: AI Summary + citations + sources.
    advance(5000);
    expect(screen.getByText(/AI Summary/i)).toBeInTheDocument();
    expect(screen.getByText('[1]')).toBeInTheDocument();
    expect(screen.getByText(/Sources \(3\)/)).toBeInTheDocument();
  });

  it('loops back to an empty scene after the end-hold', () => {
    render(<MeetingDemo />);
    advance(11000);
    expect(screen.getByText(/AI Summary/i)).toBeInTheDocument();

    // Land just past the loop boundary but before the first event (300ms) of
    // the new cycle: the scene is reset and empty again.
    advance(TIMELINE_DURATION_MS - 11000 + 150);
    expect(screen.queryByText(/AI Summary/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/where are we on the auth migration/i)).not.toBeInTheDocument();
  });
});
