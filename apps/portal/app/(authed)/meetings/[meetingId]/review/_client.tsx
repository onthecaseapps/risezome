'use client';

import { useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  AppStateProvider,
  SynthesisActionsProvider,
  TranscriptPanel,
  SynthesisStreamItem,
  useAppDispatch,
  useAppState,
  initialAppState,
  type AppState,
  type CardEvent,
  type CardRecord,
  type SynthesisActions,
  type SynthesisRecord,
  type TranscriptUtterance,
} from '@risezome/hud-ui';
import type { InitialSynthesis } from '../_synthesis-seed';
import type { RecapParticipant, StructuredRecap } from '../../../../../src/inngest/lib/meeting-recap';
import { pinSynthesisAction } from '../live/synthesis-actions-server';

/**
 * Post-meeting review (U8). Mirrors the live view's styling: a generated
 * whole-meeting recap on top, then the full transcript with the utterances
 * that triggered an AI summary highlighted — click one to open its synthesis
 * card (the same hud-ui card the live page renders). Static: seeds the reducer
 * once, no Realtime.
 */

export type RecapStatus = 'generating' | 'done' | 'failed' | null;

export interface ReviewClientProps {
  meetingId: string;
  title: string;
  status: string;
  startedAtIso: string | null;
  endedAtIso: string | null;
  recapText: string | null;
  /** Structured recap (new meetings). Null for old meetings / decrypt degrade → markdown fallback. */
  structuredRecap?: StructuredRecap | null;
  recapStatus: RecapStatus;
  initialTranscript: TranscriptUtterance[];
  initialSyntheses: InitialSynthesis[];
  initialCards: CardEvent[];
  /** utteranceId → synthesisId for the transcript anchors. */
  anchorMap: Record<string, string>;
}

function seedState(
  cards: CardEvent[],
  syntheses: InitialSynthesis[],
  transcript: TranscriptUtterance[],
): AppState {
  const cardMap = new Map<string, CardRecord>();
  for (const card of cards) cardMap.set(card.cardId, { card, pinned: false });

  const synthMap = new Map<string, SynthesisRecord>();
  for (const s of syntheses) {
    synthMap.set(s.synthesisId, {
      synthesisId: s.synthesisId,
      sourceCardIds: s.sourceCardIds,
      traceId: s.traceId,
      accumulatedText: s.accumulatedText,
      streaming: false,
      citations: s.citations,
      ...(s.additionalSources !== undefined && s.additionalSources.length > 0
        ? { additionalSources: s.additionalSources }
        : {}),
      ...(s.toolSource !== undefined ? { toolSource: s.toolSource } : {}),
      pinned: s.pinned,
      pinnedAt: s.pinnedAt,
      ...(s.triggerUtteranceId != null ? { triggerUtteranceId: s.triggerUtteranceId } : {}),
      ...(s.stopReason !== undefined ? { stopReason: s.stopReason } : {}),
      ...(s.ttftMs !== undefined ? { ttftMs: s.ttftMs } : {}),
      ...(s.latencyMs !== undefined ? { latencyMs: s.latencyMs } : {}),
      ...(s.usage !== undefined ? { usage: s.usage } : {}),
    });
  }

  const transcriptMap = new Map<string, TranscriptUtterance>();
  for (const u of transcript) transcriptMap.set(u.utteranceId, u);

  return { ...initialAppState, status: 'disconnected', meeting: 'idle', cards: cardMap, syntheses: synthMap, transcript: transcriptMap };
}

export function ReviewClient(props: ReviewClientProps): ReactElement {
  const seeded = useMemo<AppState>(
    () => seedState(props.initialCards, props.initialSyntheses, props.initialTranscript),
    [props.initialCards, props.initialSyntheses, props.initialTranscript],
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full flex-col lg:max-w-[80%]">
      <header className="border-b border-border px-6 py-5 sm:px-8">
        <a href="/upcoming" className="text-xs text-muted hover:text-fg">
          ← Upcoming
        </a>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
            <span className="text-sm text-muted">
              <StatusBadge status={props.status} /> · {formatRange(props.startedAtIso, props.endedAtIso)}
            </span>
          </div>
        </div>
      </header>

      {/* Meeting recap on top (full width, divider below), then a split view:
          transcript on the left, surfaced answers on the right, divided by a
          rule. AppStateProvider is transparent (context only), so the recap
          section and the split grid are direct flex children of the column. */}
      <AppStateProvider initial={seeded}>
        <RecapSection
          structuredRecap={props.structuredRecap ?? null}
          recapText={props.recapText}
          recapStatus={props.recapStatus}
        />
        <ReviewSynthesisActions>
          <ReviewSplit anchorMap={props.anchorMap} transcript={props.initialTranscript} />
        </ReviewSynthesisActions>
      </AppStateProvider>
    </div>
  );
}

/**
 * Provides pin/unpin for the surfaced synthesis cards on the review page — the
 * same optimistic-then-server pattern the live page uses (rollback on failure),
 * so a completed answer can be pinned post-meeting. Must sit inside
 * AppStateProvider (it dispatches into the reducer). Without this the pin button
 * hides entirely (SynthesisCard's PinButton returns null with no actions wired).
 */
function ReviewSynthesisActions({ children }: { children: ReactNode }): ReactElement {
  const dispatch = useAppDispatch();
  const state = useAppState();
  // The actions memo only depends on dispatch, so read the latest state through
  // a ref — a closure over `state` would capture the first render's snapshot.
  const stateRef = useRef(state);
  stateRef.current = state;
  const actions = useMemo<SynthesisActions>(
    () => ({
      pin: async (synthesisId: string) => {
        dispatch({ type: 'synthesisPinned', synthesisId, pinned: true, pinnedAt: new Date().toISOString() });
        const result = await pinSynthesisAction(synthesisId, true);
        if (!result.ok) {
          dispatch({ type: 'synthesisPinned', synthesisId, pinned: false, pinnedAt: null });
          throw new Error(result.error);
        }
      },
      unpin: async (synthesisId: string) => {
        // Capture the record's actual pinnedAt BEFORE the optimistic clear so a
        // failed server unpin restores the real timestamp, not a fabricated one.
        const priorPinnedAt = stateRef.current.syntheses.get(synthesisId)?.pinnedAt ?? null;
        dispatch({ type: 'synthesisPinned', synthesisId, pinned: false, pinnedAt: null });
        const result = await pinSynthesisAction(synthesisId, false);
        if (!result.ok) {
          dispatch({
            type: 'synthesisPinned',
            synthesisId,
            pinned: true,
            pinnedAt: priorPinnedAt,
          });
          throw new Error(result.error);
        }
      },
    }),
    [dispatch],
  );
  return <SynthesisActionsProvider actions={actions}>{children}</SynthesisActionsProvider>;
}

function ReviewSplit({
  anchorMap,
  transcript,
}: {
  anchorMap: Record<string, string>;
  transcript: TranscriptUtterance[];
}): ReactElement {
  const anchored = useMemo(() => new Set(Object.keys(anchorMap)), [anchorMap]);
  // The raw transcript arrives in event_id order, which is NOT guaranteed to be
  // time order. Sort once and use the SAME array for both the surfaced ordering
  // and TranscriptPanel, so DOM order == time order (jump-to-moment and the
  // SURFACED pager both assume it).
  const sortedTranscript = useMemo(
    () => [...transcript].sort((a, b) => a.startMs - b.startMs),
    [transcript],
  );
  // Surfaced answers in transcript order — one entry per anchored question.
  // Drives the SURFACED pagination and links it to the transcript highlight.
  const ordered = useMemo(() => {
    const list: { utteranceId: string; synthesisId: string }[] = [];
    for (const u of sortedTranscript) {
      const sid = anchorMap[u.utteranceId];
      if (sid !== undefined) list.push({ utteranceId: u.utteranceId, synthesisId: sid });
    }
    return list;
  }, [sortedTranscript, anchorMap]);

  const count = ordered.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const safeIndex = count === 0 ? -1 : Math.min(activeIndex, count - 1);
  const active = safeIndex >= 0 ? ordered[safeIndex] : undefined;

  const col = 'min-w-0 px-6 py-6 sm:px-8';
  const label = 'text-xs font-medium uppercase tracking-wider text-muted';

  return (
    <div className="grid flex-1 grid-cols-1 divide-y divide-border lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:divide-x lg:divide-y-0">
      <section className={col}>
        <h2 className={`mb-3 ${label}`}>Transcript</h2>
        {transcript.length === 0 ? (
          <p className="text-sm text-muted">No transcript was captured for this meeting.</p>
        ) : (
          <TranscriptPanel
            utterances={sortedTranscript}
            anchoredUtteranceIds={anchored}
            onAnchorClick={(utteranceId) => {
              const idx = ordered.findIndex((o) => o.utteranceId === utteranceId);
              if (idx >= 0) setActiveIndex(idx);
            }}
            activeUtteranceId={active?.utteranceId ?? null}
          />
        )}
      </section>

      {/* Surfaced panel reads as a distinct surface via a subtle card tint. The
          column stretches to the transcript's height (full-height tint); the
          inner content sticks to the top so the summary stays in view while a
          long transcript scrolls past it. */}
      <section className={`${col} bg-card/40`}>
        <div className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className={label}>Surfaced</h2>
            {count > 1 ? (
              <Stepper
                index={safeIndex}
                count={count}
                onPrev={() => setActiveIndex((i) => Math.max(0, Math.min(i, count - 1) - 1))}
                onNext={() => setActiveIndex((i) => Math.min(count - 1, i + 1))}
              />
            ) : null}
          </div>
          {active !== undefined ? (
            <ActiveSynthesis synthesisId={active.synthesisId} />
          ) : (
            <p className="text-sm text-muted">No summaries were generated in this meeting.</p>
          )}
        </div>
      </section>
    </div>
  );
}

/** SURFACED 1 / N pager. Clamped (no wrap); arrows disable at the ends. */
function Stepper({
  index,
  count,
  onPrev,
  onNext,
}: {
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}): ReactElement {
  const btn =
    'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-muted transition-colors hover:text-fg hover:border-accent/40 disabled:opacity-40 disabled:hover:text-muted disabled:hover:border-border';
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <button type="button" className={btn} onClick={onPrev} disabled={index <= 0} aria-label="Previous answer">
        ‹
      </button>
      <span className="tabular-nums">
        {index + 1} / {count}
      </span>
      <button
        type="button"
        className={btn}
        onClick={onNext}
        disabled={index >= count - 1}
        aria-label="Next answer"
      >
        ›
      </button>
    </div>
  );
}

function ActiveSynthesis({ synthesisId }: { synthesisId: string }): ReactElement | null {
  const state = useAppState();
  const record = state.syntheses.get(synthesisId);
  if (record === undefined) return null;
  return <SynthesisStreamItem syn={record} />;
}

/**
 * The meeting-recap section. Prefers the structured recap (new meetings); falls
 * back to the legacy markdown for old meetings; degrades to a muted state for
 * generating / failed / absent.
 */
function RecapSection({
  structuredRecap,
  recapText,
  recapStatus,
}: {
  structuredRecap: StructuredRecap | null;
  recapText: string | null;
  recapStatus: RecapStatus;
}): ReactElement {
  if (recapStatus === 'done' && structuredRecap !== null) {
    return (
      <section className="border-b border-border px-6 py-6 sm:px-8">
        <StructuredRecapView recap={structuredRecap} />
      </section>
    );
  }
  return (
    <section className="border-b border-border px-6 py-6 sm:px-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Meeting recap</h2>
      </div>
      <RecapBody text={recapText} status={recapStatus} />
    </section>
  );
}

/** `mm:ss` clock for display; null when no timestamp (minutes may exceed 59). */
function mmss(ms: number | null): string | null {
  if (ms === null) return null;
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Small stroked icon, mirroring the mockup's inline SVGs. */
function Icon({ path, size = 16, sw = 1.8 }: { path: ReactNode; size?: number; sw?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  );
}

// Decision-tag + avatar palette (the mockup's accent hexes — theme-independent on
// purpose: these are categorical colors, not UI-chrome tokens). The teal is the
// mockup's --hue-doc, used for the decision "check" mark.
const TEAL = '#2fb6a3';
const CATEGORY_COLORS: Record<string, string> = {
  Commercial: '#5159e0',
  Ventel: '#2fb6a3',
  Schema: '#4d8df6',
  Coverage: '#e6a23c',
  Delivery: '#b072e0',
  Linkage: '#e0795b',
};
const PALETTE = ['#5159e0', '#2fb6a3', '#4d8df6', '#e6a23c', '#b072e0', '#e0795b'];
function hashed(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? PALETTE[0]!;
}
function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? hashed(cat);
}

/**
 * Index of the transcript utterance "playing" at `ms`: the one with the MAX
 * start at or before the moment. Scans every entry (no early break) so it is
 * correct even if the input isn't time-ascending — DOM/data order is event_id
 * order, which isn't guaranteed to be time order. Ties go to the later index
 * (matches the previous sorted-input behaviour). Falls back to the earliest
 * utterance when the moment precedes all of them. -1 for an empty list.
 * Pure + exported for unit testing.
 */
export function nearestUtteranceIndex(startMs: readonly number[], ms: number): number {
  if (startMs.length === 0) return -1;
  let idx = -1;
  let best = -Infinity;
  let earliestIdx = 0;
  let earliest = Infinity;
  for (let i = 0; i < startMs.length; i += 1) {
    const s = startMs[i]!;
    if (s < earliest) {
      earliest = s;
      earliestIdx = i;
    }
    if (s <= ms && s >= best) {
      best = s;
      idx = i;
    }
  }
  return idx >= 0 ? idx : earliestIdx;
}

/**
 * Scroll the transcript to the utterance spoken at `ms` and briefly pulse it.
 * Targets the `data-start-ms` anchors TranscriptPanel renders (DOM order ==
 * time order). Honors prefers-reduced-motion (instant scroll, no animation).
 *
 * Reference-frame note: transcript `startMs` is ABSOLUTE (epoch-style) ms, but a
 * recap's `timestampMs` is relative elapsed-from-first-utterance (the recap
 * builder subtracts the earliest startMs — see flattenTranscriptLines). So we
 * normalize each utterance the same way (subtract the minimum startMs) before
 * matching, otherwise every relative `ms` is smaller than every absolute start
 * and the match collapses to the first line.
 */
function scrollToMoment(ms: number): void {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.transcript [data-start-ms]'));
  if (nodes.length === 0) return;
  const starts = nodes.map((n) => Number(n.dataset['startMs']));
  const finite = starts.filter((s) => Number.isFinite(s));
  // Utterances with a missing startMs default to 0; when other utterances carry
  // real (positive, epoch-style) values, a defaulted 0 would drag the baseline
  // to 0 and break the relative mapping — exclude them from the baseline.
  const real = finite.filter((s) => s > 0);
  const baseline = real.length > 0 ? Math.min(...real) : finite.length > 0 ? Math.min(...finite) : 0;
  const relative = starts.map((s) => (Number.isFinite(s) ? s - baseline : 0));
  const idx = nearestUtteranceIndex(relative, ms);
  const target = nodes[idx];
  if (target === undefined) return;
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  // Restart the animation if the same target is clicked again: drop the class,
  // force a reflow, then re-add. The class self-clears via the timer.
  target.classList.remove('rz-ts-pulse');
  void target.offsetWidth;
  target.classList.add('rz-ts-pulse');
  // Past the 3.4s animation so the cleanup never clips the fade.
  window.setTimeout(() => target.classList.remove('rz-ts-pulse'), 3500);
}

/** A jump-to-moment timestamp chip (clock + mm:ss). Click scrolls the transcript
 *  to that moment and briefly pulses the utterance. */
function Moment({ ms }: { ms: number }): ReactElement {
  const label = mmss(ms) ?? '';
  return (
    <button
      type="button"
      onClick={() => scrollToMoment(ms)}
      title="Jump to this moment in the transcript"
      aria-label={`Jump to ${label} in the transcript`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-accent transition-colors hover:brightness-110"
      style={{ background: 'var(--accent-soft)' }}
    >
      <Icon
        path={
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 2" />
          </>
        }
        size={11}
        sw={2}
      />
      {label}
    </button>
  );
}

/** A colored circular initials avatar; color hashed from the name (mockup palette). */
function Avatar({ name, size = 24 }: { name: string; size?: number }): ReactElement {
  const initials = name
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: hashed(name), fontSize: size * 0.4 }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

/** A decision subject tag, colored per category. */
function Tag({ label }: { label: string }): ReactElement {
  const c = categoryColor(label);
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{ background: `color-mix(in srgb, ${c} 13%, transparent)`, color: c }}
    >
      {label}
    </span>
  );
}

function SectionTitle({
  children,
  count,
  id,
}: {
  children: ReactNode;
  count?: number;
  id?: string;
}): ReactElement {
  return (
    <div id={id} className="mb-3.5 flex items-center gap-2.5">
      <h2 className="text-base font-semibold tracking-tight text-fg">{children}</h2>
      {count !== undefined ? (
        <span
          className="rounded-full px-2 py-px font-mono text-xs text-muted"
          style={{ background: 'var(--provisional-bg)' }}
        >
          {count}
        </span>
      ) : null}
    </div>
  );
}

const STAT_ICONS: Record<string, ReactNode> = {
  'stat-topics': <path d="M4 6h16M4 12h16M4 18h10" />,
  'stat-decisions': (
    <>
      <path d="M5 12.5l4.5 4.5L19 7" />
      <path d="M3 20h18" />
    </>
  ),
  'stat-actions': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  'stat-attendees': (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6a3 3 0 0 1 0 6M20.5 19a5.5 5.5 0 0 0-4-5.3" />
    </>
  ),
};

/** The structured recap layout: stat tiles, AI-summary lead, topics, decisions, action items, rail. */
function StructuredRecapView({ recap }: { recap: StructuredRecap }): ReactElement {
  const stats: { label: string; value: number; testid: string }[] = [
    { label: 'Key topics', value: recap.topics.length, testid: 'stat-topics' },
    { label: 'Decisions', value: recap.decisions.length, testid: 'stat-decisions' },
    { label: 'Action items', value: recap.action_items.length, testid: 'stat-actions' },
    { label: 'Attendees', value: recap.participants.length, testid: 'stat-attendees' },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_244px] lg:items-start">
      <div className="min-w-0">
        {/* at-a-glance stat tiles */}
        <div className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {stats.map((s) => (
            <div
              key={s.testid}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--card-shadow)]"
            >
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon path={STAT_ICONS[s.testid]} size={17} />
              </span>
              <div className="leading-tight">
                <div data-testid={s.testid} className="text-lg font-semibold tracking-tight tabular-nums text-fg">
                  {s.value}
                </div>
                <div className="text-xs font-medium text-muted">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* AI summary lead */}
        <section id="sec-overview" className="mb-7">
          <div className="rounded-2xl border border-border bg-card px-5 py-4 shadow-[var(--card-shadow)]">
            <div className="mb-3 flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-accent"
                style={{ background: 'var(--accent-soft)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z" />
                </svg>
                Recap
              </span>
              <span className="text-xs font-semibold text-muted">AI summary</span>
              <span className="ml-auto text-[11px] text-muted">
                grounded in transcript
                {recap.speakerCount > 0 ? ` · ${String(recap.speakerCount)} speakers` : ''}
              </span>
            </div>
            <p className="text-[15px] leading-relaxed text-fg">{recap.overview}</p>
          </div>
        </section>

        {/* key topics */}
        {recap.topics.length > 0 ? (
          <section id="sec-topics" className="mb-7">
            <SectionTitle count={recap.topics.length}>Key topics</SectionTitle>
            <div className="flex flex-col">
              {recap.topics.map((t, i) => {
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-3 px-0.5 py-3${i < recap.topics.length - 1 ? ' border-b border-border' : ''}`}
                  >
                    <span className="w-4 shrink-0 font-mono text-[11.5px] text-muted">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1 text-sm leading-snug text-fg">{t.text}</span>
                    {t.timestampMs !== null ? <Moment ms={t.timestampMs} /> : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* decisions */}
        {recap.decisions.length > 0 ? (
          <section id="sec-decisions" className="mb-7">
            <SectionTitle count={recap.decisions.length}>Decisions</SectionTitle>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {recap.decisions.map((d, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5 shadow-[var(--card-shadow)]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
                      style={{ background: 'color-mix(in srgb, #2fb6a3 12%, transparent)', color: TEAL }}
                    >
                      <Icon path={<path d="M5 12.5l4.5 4.5L19 7" />} size={13} sw={2.6} />
                    </span>
                    {d.category.length > 0 ? <Tag label={d.category} /> : null}
                  </div>
                  <div className="text-sm leading-snug text-fg">{d.text}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* action items — display-only (no checkboxes / done-state) */}
        {recap.action_items.length > 0 ? (
          <section id="sec-actions">
            <SectionTitle count={recap.action_items.length}>Action items</SectionTitle>
            <div className="flex flex-col gap-2.5">
              {recap.action_items.map((a, i) => {
                const ts = mmss(a.timestampMs);
                return (
                  <div key={i} className="rounded-xl border border-border bg-card px-4 py-3.5 shadow-[var(--card-shadow)]">
                    <div className="text-sm leading-snug text-fg">{a.text}</div>
                    {a.assignee !== null || ts !== null ? (
                      <div className="mt-2.5 flex items-center gap-2">
                        {a.assignee !== null ? (
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-muted"
                            style={{ background: 'var(--provisional-bg)' }}
                          >
                            <Avatar name={a.assignee} size={18} />
                            {a.assignee}
                          </span>
                        ) : null}
                        {a.timestampMs !== null ? <Moment ms={a.timestampMs} /> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      <RecapRail participants={recap.participants} />
    </div>
  );
}

const NAV_ITEMS: { label: string; id: string }[] = [
  { label: 'Overview', id: 'sec-overview' },
  { label: 'Key topics', id: 'sec-topics' },
  { label: 'Decisions', id: 'sec-decisions' },
  { label: 'Action items', id: 'sec-actions' },
];

/** Right rail: jump-nav + participants card (collapsed when none) + recap-meta. */
function RecapRail({ participants }: { participants: readonly RecapParticipant[] }): ReactElement {
  return (
    <aside className="flex flex-col gap-3.5 lg:sticky lg:top-6">
      <nav className="rounded-xl border border-border bg-card p-2 shadow-[var(--card-shadow)]">
        {NAV_ITEMS.map((n) => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          >
            <span className="h-[5px] w-[5px] rounded-full bg-border" />
            {n.label}
          </a>
        ))}
      </nav>

      {participants.length > 0 ? (
        <div className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[var(--card-shadow)]">
          <div className="mb-3 text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted">Participants</div>
          <ul className="flex flex-col gap-2.5" data-testid="participant-list">
            {participants.map((p) => (
              <li key={p.name} className="flex items-center gap-2.5 text-xs font-medium text-fg">
                <Avatar name={p.name} />
                {p.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-[var(--card-shadow)]">
        <p className="text-xs leading-relaxed text-muted">
          Recap generated by Risezome from the meeting transcript.
        </p>
      </div>
    </aside>
  );
}

function RecapBody({ text, status }: { text: string | null; status: RecapStatus }): ReactElement {
  if (status === 'done' && text !== null && text.length > 0) return <RecapMarkdown text={text} />;
  if (status === 'generating')
    return <p className="text-sm text-muted">Generating the meeting recap…</p>;
  if (status === 'failed')
    return <p className="text-sm text-muted">The recap could not be generated for this meeting.</p>;
  return <p className="text-sm text-muted">No recap available for this meeting.</p>;
}

/**
 * Minimal markdown renderer for the recap (no dependency): `#`/`##` headings,
 * `-`/`*`/`N.` list items, `**bold**` inline, blank-line paragraphs. The recap
 * prompt only emits this small subset, so a full markdown library isn't
 * warranted; swap one in here if the recap format ever grows richer.
 */
function RecapMarkdown({ text }: { text: string }): ReactElement {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flushBullets = (): void => {
    if (bullets.length > 0) {
      out.push(
        <ul key={`ul-${String(out.length)}`} className="mb-2 ml-4 list-disc text-sm text-fg">
          {bullets}
        </ul>,
      );
      bullets = [];
    }
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    // `-`, `*`, or `1.` — all rendered as list items so numbered action items
    // don't fall through to plain paragraphs.
    const bullet = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushBullets();
      out.push(
        <h3 key={`h-${String(i)}`} className="mb-1 mt-3 text-sm font-semibold text-fg first:mt-0">
          {inline(heading[1] ?? '')}
        </h3>,
      );
    } else if (bullet !== null) {
      bullets.push(<li key={`li-${String(i)}`}>{inline(bullet[1] ?? '')}</li>);
    } else if (line.length === 0) {
      flushBullets();
    } else {
      flushBullets();
      out.push(
        <p key={`p-${String(i)}`} className="mb-2 text-sm text-fg">
          {inline(line)}
        </p>,
      );
    }
  });
  flushBullets();
  return <div>{out}</div>;
}

/** Render `**bold**` spans inline; everything else is plain text. */
function inline(s: string): ReactNode {
  const parts = s.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

function StatusBadge({ status }: { status: string }): ReactElement {
  const map: Record<string, { label: string; className: string }> = {
    completed: { label: 'Completed', className: 'bg-emerald-500/15 text-emerald-400' },
    failed: { label: 'Failed', className: 'bg-rose-500/15 text-rose-400' },
    recording: { label: 'In progress', className: 'bg-accent-soft text-accent' },
  };
  const v = map[status] ?? { label: status, className: 'bg-bg/60 text-muted' };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${v.className}`}
    >
      {v.label}
    </span>
  );
}

function formatRange(startIso: string | null, endIso: string | null): string {
  if (startIso === null) return 'never started';
  const start = new Date(startIso);
  if (endIso === null) {
    return `started ${start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  const end = new Date(endIso);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return `${start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${String(minutes)}m`;
}
