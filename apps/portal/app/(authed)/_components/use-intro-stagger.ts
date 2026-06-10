'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

const STAGGER_MS = 45; // gap between consecutive items
const STAGGER_CAP = 9; // clamp to the first ~10 items (rest arrive instantly)
const DURATION_MS = 500; // must match the rz-fade-up keyframe duration in globals.css

export interface IntroProps {
  className: string;
  style: CSSProperties | undefined;
}

/**
 * Intro stagger for list pages: a subtle fade-up that plays on the FIRST mount
 * only and then turns itself off, so filter/sort/search re-renders stay instant
 * (animating cards on every filter change reads as sluggish). Returns a function
 * that, given an item's running render index, yields the className + inline
 * `animation-delay` to spread on the item's root element.
 *
 * Index is the GLOBAL position across all groups (thread a running counter
 * through grouped lists), so the stagger walks top-to-bottom over the whole
 * page rather than restarting per group. The delay is clamped to STAGGER_CAP so
 * a long list's tail doesn't trickle in late.
 *
 * SSR-safe: `intro` starts true on both server and client initial render, so the
 * class is present in the first paint (no hydration mismatch) and the animation
 * begins immediately. Reduced-motion is handled in CSS (the class becomes inert).
 */
export function useIntroStagger(): (index: number) => IntroProps {
  const [intro, setIntro] = useState(true);
  // Guard against a re-mount re-triggering: once played, stays played.
  const played = useRef(false);

  useEffect(() => {
    if (played.current) {
      setIntro(false);
      return;
    }
    // Let the longest-delayed item finish before stripping the class, so the
    // tail doesn't snap to its final state mid-animation.
    const total = DURATION_MS + STAGGER_CAP * STAGGER_MS + 50;
    const t = setTimeout(() => {
      played.current = true;
      setIntro(false);
    }, total);
    return () => clearTimeout(t);
  }, []);

  return (index: number): IntroProps => {
    if (!intro) return { className: '', style: undefined };
    const capped = Math.min(Math.max(index, 0), STAGGER_CAP);
    return { className: 'rz-fade-up', style: { animationDelay: `${capped * STAGGER_MS}ms` } };
  };
}
