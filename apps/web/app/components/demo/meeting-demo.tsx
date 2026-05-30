'use client';

import { useEffect, useRef, useState } from 'react';
import './demo.css';
import { DemoHeader } from './demo-header';
import { Transcript } from './transcript';
import { HudCard } from './hud-card';
import { SynthesisCard } from './synthesis-card';
import {
  INITIAL_STATE,
  TIMELINE_DURATION_MS,
  stateAtElapsed,
  terminalState,
  type DemoState,
} from './demo-timeline';

const MEETING_LABEL = 'Sprint standup · #eng-planning';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The simulated meeting. Drives the HUD-faithful components from the canned
 * timeline (plan U6):
 *  - playback runs on mount and loops with an end-hold;
 *  - an IntersectionObserver *pauses* it while scrolled offscreen (it does not
 *    gate the initial start, so flaky/absent IO can't leave it stuck empty);
 *  - prefers-reduced-motion renders the finished scene statically, no loop.
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

    // Start immediately — playback does not depend on the observer firing.
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

  // Once the answer is finalized, the raw cards consolidate into the synthesis
  // card's Sources grid — mirroring the HUD. Until then they stream above it.
  const synthDone = state.synthesis !== null && !state.synthesis.streaming;
  const showRawCards = !synthDone;
  const typingTranscript = state.synthesis === null && state.transcript.length > 0;

  // Entry animations are mounted via a stable `is-entering` class so they play
  // to completion (the per-frame re-render keeps the class unchanged) and
  // replay only when an element unmounts/remounts across a loop reset.
  return (
    <div className="upwell-hud" ref={containerRef} aria-label="Simulated Upwell meeting">
      <DemoHeader meetingLabel={MEETING_LABEL} />
      <Transcript lines={state.transcript} activeLineTyping={typingTranscript} />
      <div className="card-stream">
        {state.synthesis !== null && (
          <div className="synthesis-reveal is-entering">
            <div className="synthesis-reveal-inner">
              <SynthesisCard
                synthesis={{
                  text: state.synthesis.text,
                  citations: state.synthesis.citations,
                  sources: state.synthesis.sources,
                }}
                streaming={state.synthesis.streaming}
              />
            </div>
          </div>
        )}
        {showRawCards &&
          state.cards.map((card) => <HudCard key={card.id} card={card} entering />)}
      </div>
    </div>
  );
}
