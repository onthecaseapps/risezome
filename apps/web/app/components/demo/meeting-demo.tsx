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

/**
 * The simulated meeting. Drives the HUD-faithful components from the canned
 * timeline (plan U6):
 *  - auto-starts when scrolled into view (IntersectionObserver) and pauses
 *    when offscreen, accumulating elapsed time only while visible;
 *  - loops with a hold at the end;
 *  - honors prefers-reduced-motion by rendering the finished scene statically.
 */
export function MeetingDemo(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DemoState>(INITIAL_STATE);

  // Cards/synthesis that have already animated in, so is-entering fires exactly
  // once per appearance (and again after a loop reset clears the set).
  const seenCardsRef = useRef<Set<string>>(new Set());
  const seenSynthesisRef = useRef(false);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      // Static end-state: the full scene, no animation, no loop.
      setState(terminalState());
      return;
    }

    const elapsedRef = { value: 0 };
    let lastTs = 0;
    let raf = 0;
    let visible = false;

    const frame = (ts: number): void => {
      if (lastTs === 0) lastTs = ts;
      const dt = ts - lastTs;
      lastTs = ts;
      elapsedRef.value += dt;
      if (elapsedRef.value >= TIMELINE_DURATION_MS) {
        elapsedRef.value = 0;
        seenCardsRef.current.clear();
        seenSynthesisRef.current = false;
      }
      setState(stateAtElapsed(elapsedRef.value));
      raf = window.requestAnimationFrame(frame);
    };

    const start = (): void => {
      if (raf !== 0) return;
      lastTs = 0; // avoid a dt spike after a pause
      raf = window.requestAnimationFrame(frame);
    };
    const stop = (): void => {
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const el = containerRef.current;
    let observer: IntersectionObserver | null = null;
    if (el !== null && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            visible = entry.isIntersecting;
            if (visible) start();
            else stop();
          }
        },
        { threshold: 0.25 },
      );
      observer.observe(el);
    } else {
      // No IntersectionObserver (older runtime / tests): just play.
      start();
    }

    return (): void => {
      stop();
      if (observer !== null) observer.disconnect();
    };
  }, []);

  // After paint, mark what's now on screen as "seen" so it doesn't re-animate
  // on the next frame's re-render.
  useEffect(() => {
    for (const card of state.cards) seenCardsRef.current.add(card.id);
    if (state.synthesis !== null) seenSynthesisRef.current = true;
  }, [state]);

  // Once the answer is finalized, the raw cards consolidate into the synthesis
  // card's Sources grid — mirroring the HUD. Until then they stream above it.
  const synthDone = state.synthesis !== null && !state.synthesis.streaming;
  const showRawCards = !synthDone;
  const typingTranscript = state.synthesis === null && state.transcript.length > 0;

  return (
    <div className="upwell-hud" ref={containerRef} aria-label="Simulated Upwell meeting">
      <DemoHeader meetingLabel={MEETING_LABEL} />
      <Transcript lines={state.transcript} activeLineTyping={typingTranscript} />
      <div className="card-stream">
        {showRawCards &&
          state.cards.map((card) => (
            <HudCard key={card.id} card={card} entering={!seenCardsRef.current.has(card.id)} />
          ))}
        {state.synthesis !== null && (
          <SynthesisCard
            synthesis={{
              text: state.synthesis.text,
              citations: state.synthesis.citations,
              sources: state.synthesis.sources,
            }}
            streaming={state.synthesis.streaming}
            entering={!seenSynthesisRef.current}
          />
        )}
      </div>
    </div>
  );
}
