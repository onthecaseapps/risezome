'use client';

import { useEffect, useRef, useState } from 'react';
import './demo.css';
import { DemoHeader } from './demo-header';
import { Transcript } from './transcript';
import { SynthesisCard } from './synthesis-card';
import {
  INITIAL_STATE,
  STEP_LABEL,
  TIMELINE_DURATION_MS,
  stateAtElapsed,
  stepFor,
  terminalState,
  type DemoState,
} from './demo-timeline';

const MEETING_LABEL = 'Sprint standup · #eng-planning';

// The fully-played scene. Rendered invisibly as a "sizer" so the demo always
// reserves the height of its tallest state — otherwise the column grows as the
// answer streams in and shoves the rest of the hero around.
const TERMINAL: DemoState = terminalState();

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The synthesis block (reveal wrapper + card). Shared by the live overlay and
 *  the invisible sizer so both measure/animate identically. */
function SynthesisBlock({
  synthesis,
  entering,
}: {
  synthesis: NonNullable<DemoState['synthesis']>;
  entering: boolean;
}): React.ReactElement {
  return (
    <SynthesisCard
      synthesis={{
        text: synthesis.text,
        citations: synthesis.citations,
        sources: synthesis.sources,
        expandedSourceId: synthesis.expandedSourceId,
      }}
      streaming={synthesis.streaming}
      entering={entering}
    />
  );
}

/**
 * The simulated meeting. Drives the HUD-faithful components from the canned
 * timeline: a question lands and Risezome goes straight to a cited AI Summary
 * (no intermediate raw cards — the supporting sources live inside the summary).
 *  - playback runs on mount and loops with an end-hold;
 *  - an IntersectionObserver *pauses* it while scrolled offscreen (it does not
 *    gate the initial start, so flaky/absent IO can't leave it stuck empty);
 *  - prefers-reduced-motion renders the finished scene statically, no loop;
 *  - an invisible terminal-state sizer reserves height so the column never
 *    grows/shrinks as the answer streams in (no layout shift).
 */
export function MeetingDemo(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DemoState>(INITIAL_STATE);

  useEffect(() => {
    if (prefersReducedMotion()) {
      // Static end-state: the full scene, no animation, no loop.
      setState(terminalState());
      return;
    }

    let raf = 0;
    let lastTs = 0;
    let elapsed = 0;
    let paused = false;

    const frame = (ts: number): void => {
      if (paused) {
        lastTs = ts; // keep the clock from jumping while paused
        raf = window.requestAnimationFrame(frame);
        return;
      }
      if (lastTs === 0) lastTs = ts;
      elapsed += ts - lastTs;
      lastTs = ts;
      if (elapsed >= TIMELINE_DURATION_MS) {
        elapsed = 0;
      }
      setState(stateAtElapsed(elapsed));
      raf = window.requestAnimationFrame(frame);
    };

    // Start immediately - playback does not depend on the observer firing.
    raf = window.requestAnimationFrame(frame);

    // Observer only pauses/resumes based on visibility.
    let observer: IntersectionObserver | null = null;
    const el = containerRef.current;
    if (el !== null && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) paused = !entry.isIntersecting;
        },
        { threshold: 0 },
      );
      observer.observe(el);
    }

    return (): void => {
      window.cancelAnimationFrame(raf);
      if (observer !== null) observer.disconnect();
    };
  }, []);

  const typingTranscript = state.synthesis === null && state.transcript.length > 0;

  return (
    <div className="risezome-hud" ref={containerRef} aria-label="Simulated Risezome meeting">
      <DemoHeader meetingLabel={MEETING_LABEL} />
      {/* Stack the layers in one grid cell: an invisible sizer (the finished
          scene) reserves the cell's height while the live scene overlaps it.
          Both use `self-start` so the live layer keeps its natural (auto)
          height — an absolute/stretched overlay would give the synthesis card
          a definite height and clip its bottom padding on narrow screens. */}
      <div className="grid">
        <div
          className="invisible col-start-1 row-start-1 self-start"
          aria-hidden="true"
        >
          <Transcript lines={TERMINAL.transcript} />
          <div className="card-stream">
            {TERMINAL.synthesis !== null && (
              <SynthesisBlock synthesis={TERMINAL.synthesis} entering={false} />
            )}
          </div>
        </div>
        <div className="col-start-1 row-start-1 self-start" data-testid="demo-live">
          <Transcript lines={state.transcript} activeLineTyping={typingTranscript} />
          <div className="card-stream">
            {state.synthesis !== null && <SynthesisBlock synthesis={state.synthesis} entering />}
          </div>
        </div>
      </div>

      {/* Step caption: names the pipeline stage the scene is currently showing.
          Keyed on the step so each change re-triggers the fade-in. */}
      <div className="demo-step" aria-live="polite">
        <span className="demo-step-dot" aria-hidden="true" />
        <span key={stepFor(state)} className="demo-step-label">
          {STEP_LABEL[stepFor(state)]}
        </span>
      </div>
    </div>
  );
}
