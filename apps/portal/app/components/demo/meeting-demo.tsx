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

// How long the raw cards linger (collapsing/fading) after the answer finalizes
// before they unmount. Matches the card-collapse animation in demo.css.
const CARD_EXIT_MS = 460;

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

  // When the answer finalizes, keep the raw cards mounted briefly so they can
  // play the collapse-and-fade exit before unmounting (consolidating into the
  // synthesis Sources grid). Cleared again on the loop reset.
  const [cardsExiting, setCardsExiting] = useState(false);
  const wasDoneRef = useRef(false);
  const exitTimerRef = useRef<number | null>(null);

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

  // Once the answer is finalized, the raw cards consolidate into the synthesis
  // card's Sources grid - mirroring the HUD. Until then they stream above it.
  const synthDone = state.synthesis !== null && !state.synthesis.streaming;
  const typingTranscript = state.synthesis === null && state.transcript.length > 0;

  // Drive the consolidation: on the streaming→done transition, start the card
  // exit and schedule the unmount; on the loop reset, cancel and clear.
  useEffect(() => {
    if (synthDone && !wasDoneRef.current) {
      setCardsExiting(true);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = window.setTimeout(() => setCardsExiting(false), CARD_EXIT_MS);
    } else if (!synthDone && wasDoneRef.current) {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
      setCardsExiting(false);
    }
    wasDoneRef.current = synthDone;
  }, [synthDone]);

  useEffect(
    () => (): void => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  const showCards = (!synthDone || cardsExiting) && state.cards.length > 0;

  // Entry animations are mounted via a stable class so they play to completion
  // (the per-frame re-render keeps the class unchanged) and replay only when an
  // element unmounts/remounts across a loop reset.
  return (
    <div className="upwell-hud" ref={containerRef} aria-label="Simulated Risezome meeting">
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
        {showCards &&
          state.cards.map((card) => (
            <div
              key={card.id}
              className={cardsExiting ? 'card-collapse is-exiting' : 'card-collapse'}
            >
              <div className="card-collapse-inner">
                <HudCard card={card} entering={!cardsExiting} />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
