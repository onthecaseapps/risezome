'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import './knowledge-gaps-demo.css';

/*
 * Knowledge Gaps — marketing demo. A concise looping explainer in which a single
 * gap card assembles through three beats:
 *   1. captured automatically when the copilot can't answer a live question,
 *   2. merged across people/meetings and ranked by how often it's asked,
 *   3. assigned to an owner, then resolved.
 *
 * Ported from the Claude Design prototype (risezome/components/gaps-demo.jsx).
 * Conventions mirror MeetingDemo: a rAF clock loops the scene, an
 * IntersectionObserver pauses it offscreen, and prefers-reduced-motion renders
 * the finished (resolved) frame statically with no loop.
 */

interface Person {
  readonly n: string;
  readonly c: string;
  readonly name: string;
}

const PEOPLE: readonly Person[] = [
  { n: 'M', c: '#23a566', name: 'Marco' },
  { n: 'D', c: '#e6a23c', name: 'Dev' },
  { n: 'A', c: '#4d8df6', name: 'Ana' },
  { n: 'P', c: '#b072e0', name: 'Priya' },
  { n: 'N', c: '#5159e0', name: 'Nathan' },
];

const ASKS: readonly { readonly who: number; readonly t: string; readonly at: string }[] = [
  { who: 1, t: 'Are we still blocked on the auth migration PR?', at: 'Auth sync' },
  { who: 2, t: 'When does the OAuth2 cutover actually ship?', at: 'Platform review' },
  { who: 3, t: 'Where are we on auth migration?', at: 'Standup' },
];

const BEATS: readonly { readonly k: string; readonly t: string }[] = [
  {
    k: 'Captured automatically',
    t: "When the copilot can't answer a question in a meeting, it's logged as a gap — no manual step.",
  },
  {
    k: 'Merged & ranked by demand',
    t: 'The same question across people and meetings collapses into one gap that counts how often it’s asked.',
  },
  {
    k: 'Assigned & resolved',
    t: 'Hand a gap to an owner, then close it out — open, resolved, or dismissed.',
  },
];

// Playback tempo. The prototype ran on an 11s loop that felt rushed; SLOW
// stretches the whole clock uniformly so each beat is readable. Raise it to
// slow further, lower toward 1 to speed up. All breakpoints derive from it.
const SLOW = 1.8;
const CAP = 2600 * SLOW; // capture ramp (0 → CAP)
const MERGE = 4200 * SLOW; // merge/rank ramp, starting at CAP
const ASSIGN_AT = 7000 * SLOW; // assign/resolve ramp start
const ASSIGN = 2600 * SLOW; // assign/resolve ramp length
const OUT_AT = 10200 * SLOW; // loop-fade start
const OUT = 800 * SLOW; // loop-fade length
const CYCLE = 11000 * SLOW;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function Chevron({ s = 22, c = '#7c83ff' }: { s?: number; c?: string }): React.ReactElement {
  return (
    <svg
      width={s}
      height={s}
      viewBox="5 3.5 22 21"
      fill="none"
      stroke={c}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 24l10-8 10 8" strokeWidth="1.4" opacity=".34" />
      <path d="M8 16.5l8-6.4 8 6.4" strokeWidth="1.4" opacity=".62" />
      <path d="M10.5 9.2L16 5l5.5 4.2" strokeWidth="1.55" />
    </svg>
  );
}

function Flame({ s = 16 }: { s?: number }): React.ReactElement {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3c1 3 4 4.2 4 7.8a4 4 0 0 1-8 0c0-1.2.4-2 .9-2.6.2 1 .8 1.6 1.5 1.8C9.8 8 11 6 12 3z" />
    </svg>
  );
}

function Check({ s = 14 }: { s?: number }): React.ReactElement {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function Meeting({ s = 12 }: { s?: number }): React.ReactElement {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="11" height="10" rx="2.5" />
      <path d="M14 11l6-3v8l-6-3z" />
    </svg>
  );
}

function Av({
  p,
  s = 22,
  style,
}: {
  p: Person;
  s?: number;
  style?: CSSProperties;
}): React.ReactElement {
  return (
    <div
      style={{
        width: s,
        height: s,
        borderRadius: '50%',
        background: p.c,
        color: '#fff',
        fontSize: s * 0.42,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid var(--surface)',
        flex: '0 0 auto',
        ...style,
      }}
    >
      {p.n}
    </div>
  );
}

export function KnowledgeGapsDemo(): React.ReactElement {
  // Start from a stable value on both server and client; the effect promotes to
  // the static finished frame when reduced motion is on (avoids a hydration
  // mismatch — `window` is absent during SSR).
  const [t, setT] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setT(CYCLE * 0.92); // static finished frame, no loop
      return;
    }

    let raf = 0;
    let start = 0;
    let paused = false;

    const loop = (now: number): void => {
      if (start === 0) start = now;
      if (!paused) setT((now - start) % CYCLE);
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);

    // Pause while scrolled offscreen (matches MeetingDemo); start does not
    // depend on the observer firing, so a flaky/absent IO can't strand it.
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

  // Phases.
  const p0 = clamp(t / CAP, 0, 1); // capture
  const p1 = clamp((t - CAP) / MERGE, 0, 1); // merge/rank
  const p2 = clamp((t - ASSIGN_AT) / ASSIGN, 0, 1); // assign/resolve
  const out = clamp((t - OUT_AT) / OUT, 0, 1); // fade for loop
  const beat = t < CAP ? 0 : t < ASSIGN_AT ? 1 : 2;

  const count = Math.round(1 + easeOut(p1) * 8); // 1 → 9
  const pips = Math.min(5, 1 + Math.round(easeOut(p1) * 4));
  const meetings = Math.min(6, 1 + Math.round(easeOut(p1) * 5));
  const barW = (count / 9) * 100;
  const resolved = p2 > 0.55;
  const cardIn = easeOut(p0);
  const cardOpacity = (0.15 + 0.85 * cardIn) * (1 - out);

  // Floating ask chips ramp in, hold, then ramp out across p1 — staggered so
  // they accumulate. A long dur plus a flat hold plateau (vs the original quick
  // triangular in/out) keeps each chip on screen well past a glance.
  const chipState = (i: number): { show: boolean; o: number; y: number } => {
    const start = 0.06 + i * 0.2;
    const dur = 0.62;
    const lp = clamp((p1 - start) / dur, 0, 1);
    const life = lp < 0.18 ? lp / 0.18 : lp > 0.82 ? (1 - lp) / 0.18 : 1; // in · hold · out
    return { show: lp > 0 && lp < 1, o: life, y: (1 - life) * 8 };
  };

  const sectionChip = clamp((p1 - 0.6) / 0.4, 0, 1);
  const ownerIn = clamp(p2 / 0.5, 0, 1);

  return (
    <section className="kg px-5 py-20 sm:px-8 sm:py-28" aria-label="Knowledge Gaps demo">
      <div className="kg-grain" aria-hidden="true" />
      <div className="kg-frame">
        <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
          {/* headline */}
          <div style={{ textAlign: 'center', marginBottom: 26 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                marginBottom: 14,
              }}
            >
              <Chevron s={16} /> Knowledge Gaps
            </div>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 33,
                fontWeight: 700,
                letterSpacing: '-0.025em',
                color: 'var(--text)',
                lineHeight: 1.1,
                margin: 0,
              }}
            >
              Every unanswered question,
              <br />
              ranked by how often it’s asked.
            </h2>
          </div>

          {/* stage */}
          <div
            style={{
              position: 'relative',
              height: 300,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* glow */}
            <div
              style={{
                position: 'absolute',
                width: 520,
                height: 260,
                borderRadius: '50%',
                filter: 'blur(60px)',
                background: 'radial-gradient(circle, rgba(124,131,255,.22), transparent 70%)',
                opacity: 0.6 + p1 * 0.4,
              }}
            />

            {/* Floating ask chips (left gutter). zIndex 3 keeps them in front of
                the hero card (zIndex 2) so their inner edge layers over the card
                rather than being clipped behind it. Hidden below a width where
                the gutter would collide with the card (see .kg-chips CSS). */}
            <div
              className="kg-chips"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: '34%',
                zIndex: 3,
                pointerEvents: 'none',
              }}
            >
              {ASKS.map((a, i) => {
                const c = chipState(i);
                const P = PEOPLE[a.who]!;
                return (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: 44 + (i % 2) * 22,
                      top: 36 + i * 78,
                      opacity: c.o,
                      transform: `translateY(${c.y}px)`,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 12,
                      padding: '9px 11px',
                      width: 220,
                      boxShadow: '0 8px 24px rgba(0,0,0,.3)',
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}
                    >
                      <Av p={P} s={18} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>
                        {P.name}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>· {a.at}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                      “{a.t}”
                    </div>
                  </div>
                );
              })}
            </div>

            {/* hero gap card */}
            <div
              style={{
                position: 'relative',
                zIndex: 2,
                width: 440,
                maxWidth: '100%',
                background: 'var(--surface)',
                border: `1.5px solid ${resolved ? 'rgba(47,182,163,.5)' : 'var(--accent)'}`,
                borderRadius: 18,
                padding: '20px 22px',
                boxShadow: `0 0 0 5px ${resolved ? 'rgba(47,182,163,.08)' : 'rgba(124,131,255,.09)'}, 0 24px 60px rgba(0,0,0,.4)`,
                transform: `translateY(${(1 - cardIn) * 16}px) scale(${0.96 + cardIn * 0.04})`,
                opacity: cardOpacity,
                transition: 'border-color .4s, box-shadow .4s',
              }}
            >
              {/* top row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 13 }}>
                {/* section chip appears late in p1 */}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text-dim)',
                    background: 'var(--surface-3)',
                    border: '1px solid var(--border)',
                    borderRadius: 7,
                    padding: '3px 9px',
                    opacity: sectionChip,
                    transform: `translateY(${(1 - sectionChip) * -4}px)`,
                  }}
                >
                  <span
                    style={{ width: 6, height: 6, borderRadius: '50%', background: '#7c83ff' }}
                  />{' '}
                  Auth &amp; Identity
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '.02em',
                    borderRadius: 7,
                    padding: '4px 10px',
                    transition: 'all .35s',
                    background: resolved
                      ? 'rgba(47,182,163,.16)'
                      : p0 < 0.8
                        ? 'rgba(230,162,60,.16)'
                        : 'color-mix(in srgb, var(--accent) 16%, transparent)',
                    color: resolved
                      ? 'var(--hue-doc)'
                      : p0 < 0.8
                        ? 'var(--hue-issue)'
                        : 'var(--accent)',
                  }}
                >
                  {resolved ? (
                    <>
                      <Check s={12} />
                      Resolved
                    </>
                  ) : p0 < 0.8 ? (
                    'Couldn’t answer'
                  ) : (
                    'Open'
                  )}
                </span>
              </div>

              {/* question */}
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  color: 'var(--text)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.3,
                }}
              >
                What’s the status of the OAuth2 migration?
              </div>

              {/* demand */}
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 4px' }}
              >
                <span
                  style={{
                    color: count >= 6 ? 'var(--hue-issue)' : 'var(--accent)',
                    display: 'inline-flex',
                    transition: 'color .3s',
                  }}
                >
                  <Flame s={20} />
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 26,
                    fontWeight: 700,
                    color: 'var(--text)',
                    lineHeight: 1,
                    minWidth: 52,
                  }}
                >
                  {count}
                  <span style={{ fontSize: 15, color: 'var(--text-faint)' }}>×</span>
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--surface-3)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${barW}%`,
                      height: '100%',
                      borderRadius: 3,
                      background: count >= 6 ? 'var(--hue-issue)' : 'var(--accent)',
                      transition: 'width .25s linear, background .3s',
                    }}
                  />
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                asked this much across your team
              </div>

              {/* footer: people + meetings + owner */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  marginTop: 16,
                  paddingTop: 14,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ display: 'flex' }}>
                    {PEOPLE.slice(0, pips).map((p, i) => (
                      <span key={i} style={{ marginLeft: i ? -7 : 0 }}>
                        <Av p={p} s={22} />
                      </span>
                    ))}
                  </span>
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 12,
                    color: 'var(--text-faint)',
                  }}
                >
                  <Meeting s={13} />
                  {meetings} meetings
                </span>
                <div
                  style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Owner</span>
                  {/* assignee drops in during p2 */}
                  <div
                    style={{
                      opacity: ownerIn,
                      transform: `scale(${0.5 + ownerIn * 0.5})`,
                    }}
                  >
                    <Av p={PEOPLE[3]!} s={26} />
                  </div>
                  {p2 < 0.1 && (
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: '50%',
                        border: '1.5px dashed var(--border-strong)',
                      }}
                    />
                  )}
                </div>
              </div>

              {/* resolve pulse */}
              {resolved && (
                <div
                  data-kg-pulse
                  style={{
                    position: 'absolute',
                    inset: -1.5,
                    borderRadius: 18,
                    border: '1.5px solid rgba(47,182,163,.5)',
                    animation: 'kg-pulse 1.4s ease-out',
                  }}
                />
              )}
            </div>
          </div>

          {/* caption + progress */}
          <div style={{ textAlign: 'center', marginTop: 22, minHeight: 64 }} aria-live="polite">
            <div key={beat} data-kg-anim style={{ animation: 'kg-fade .5s ease' }}>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 17,
                  fontWeight: 700,
                  color: 'var(--text)',
                  letterSpacing: '-0.01em',
                }}
              >
                {BEATS[beat]!.k}
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  color: 'var(--text-dim)',
                  maxWidth: 440,
                  margin: '6px auto 0',
                  lineHeight: 1.5,
                }}
              >
                {BEATS[beat]!.t}
              </div>
            </div>
            <div
              style={{ display: 'flex', gap: 7, justifyContent: 'center', marginTop: 16 }}
              aria-hidden="true"
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    height: 4,
                    borderRadius: 2,
                    transition: 'all .3s',
                    width: i === beat ? 26 : 6,
                    background: i === beat ? 'var(--accent)' : 'var(--border-strong)',
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* feature tags */}
        <div className="kg-tags">
          <span className="kg-tag">
            <span className="kg-dot" style={{ background: 'var(--hue-issue)' }} />
            <b>Auto-captured</b> after every meeting
          </span>
          <span className="kg-tag">
            <span className="kg-dot" style={{ background: 'var(--accent)' }} />
            <b>Merged</b> &amp; ranked by demand
          </span>
          <span className="kg-tag">
            <span className="kg-dot" style={{ background: 'var(--hue-doc)' }} />
            <b>Assigned</b>, then resolved
          </span>
        </div>
      </div>
    </section>
  );
}
