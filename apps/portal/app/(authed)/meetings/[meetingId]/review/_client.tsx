'use client';

import { useMemo, useState, useTransition, type ReactElement, type ReactNode } from 'react';
import {
  AppStateProvider,
  TranscriptPanel,
  SynthesisStreamItem,
  useAppState,
  initialAppState,
  type AppState,
  type CardEvent,
  type CardRecord,
  type SynthesisRecord,
  type TranscriptUtterance,
} from '@risezome/hud-ui';
import type { InitialSynthesis } from '../_synthesis-seed';
import type { RecapParticipant, StructuredRecap } from '../../../../../src/inngest/lib/meeting-recap';
import type { RegenerateRecapResult } from './regenerate-recap-core';

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
  /** Server action to re-fire the recap (U6); omitted in tests/contexts without it. */
  onRegenerate?: (meetingId: string) => Promise<RegenerateRecapResult>;
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
          meetingId={props.meetingId}
          structuredRecap={props.structuredRecap ?? null}
          recapText={props.recapText}
          recapStatus={props.recapStatus}
          onRegenerate={props.onRegenerate}
        />
        <ReviewSplit anchorMap={props.anchorMap} transcript={props.initialTranscript} />
      </AppStateProvider>
    </div>
  );
}

function ReviewSplit({
  anchorMap,
  transcript,
}: {
  anchorMap: Record<string, string>;
  transcript: TranscriptUtterance[];
}): ReactElement {
  const anchored = useMemo(() => new Set(Object.keys(anchorMap)), [anchorMap]);
  // Surfaced answers in transcript order — one entry per anchored question.
  // Drives the SURFACED pagination and links it to the transcript highlight.
  const ordered = useMemo(() => {
    const sorted = [...transcript].sort((a, b) => a.startMs - b.startMs);
    const list: { utteranceId: string; synthesisId: string }[] = [];
    for (const u of sorted) {
      const sid = anchorMap[u.utteranceId];
      if (sid !== undefined) list.push({ utteranceId: u.utteranceId, synthesisId: sid });
    }
    return list;
  }, [transcript, anchorMap]);

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
            utterances={transcript}
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
 * generating / failed / absent. A live generating/failed status wins over a
 * stale structured recap so a Regenerate-in-flight reads honestly.
 */
function RecapSection({
  meetingId,
  structuredRecap,
  recapText,
  recapStatus,
  onRegenerate,
}: {
  meetingId: string;
  structuredRecap: StructuredRecap | null;
  recapText: string | null;
  recapStatus: RecapStatus;
  onRegenerate?: ((meetingId: string) => Promise<RegenerateRecapResult>) | undefined;
}): ReactElement {
  const regen =
    onRegenerate !== undefined ? (
      <RegenerateButton meetingId={meetingId} recapStatus={recapStatus} onRegenerate={onRegenerate} />
    ) : null;

  if (recapStatus === 'done' && structuredRecap !== null) {
    return (
      <section className="border-b border-border px-6 py-6 sm:px-8">
        <StructuredRecapView recap={structuredRecap} regenerate={regen} />
      </section>
    );
  }
  return (
    <section className="border-b border-border px-6 py-6 sm:px-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted">Meeting recap</h2>
        {regen}
      </div>
      <RecapBody text={recapText} status={recapStatus} />
    </section>
  );
}

/** Re-fire the recap generation. Disabled while a recap is generating/in-flight. */
function RegenerateButton({
  meetingId,
  recapStatus,
  onRegenerate,
}: {
  meetingId: string;
  recapStatus: RecapStatus;
  onRegenerate: (meetingId: string) => Promise<RegenerateRecapResult>;
}): ReactElement {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const busy = pending || recapStatus === 'generating';
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setError(false);
          startTransition(async () => {
            // The server action revalidates the route on success, re-rendering
            // the page with the new 'generating' status.
            const res = await onRegenerate(meetingId);
            if (!res.ok) setError(true);
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted"
      >
        {busy ? 'Regenerating…' : 'Regenerate'}
      </button>
      {error ? <span className="text-[11px] text-rose-400">Could not regenerate.</span> : null}
    </div>
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

const SECTION_LABEL = 'mb-2 text-xs font-medium uppercase tracking-wider text-muted';
const BADGE = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider';

/** The structured recap layout: stat cards, overview, topics, decisions, action items, participants rail. */
function StructuredRecapView({
  recap,
  regenerate,
}: {
  recap: StructuredRecap;
  regenerate: ReactNode;
}): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 space-y-6">
        <StatCards recap={recap} />

        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`${BADGE} bg-accent-soft text-accent`}>Recap</span>
            <span className="text-xs text-muted">
              grounded in transcript
              {recap.speakerCount > 0 ? ` · ${String(recap.speakerCount)} speakers` : ''}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-fg">{recap.overview}</p>
        </div>

        {recap.topics.length > 0 ? (
          <div>
            <h3 className={SECTION_LABEL}>Key topics</h3>
            <ol className="space-y-2">
              {recap.topics.map((t, i) => {
                const ts = mmss(t.timestampMs);
                return (
                  <li key={i} className="flex items-baseline gap-3 text-sm">
                    <span className="tabular-nums text-muted">{i + 1}.</span>
                    <span className="min-w-0 flex-1 text-fg">{t.text}</span>
                    {ts !== null ? (
                      <span className={`${BADGE} bg-bg/60 tabular-nums text-muted`}>{ts}</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        {recap.decisions.length > 0 ? (
          <div>
            <h3 className={SECTION_LABEL}>Decisions</h3>
            <div className="space-y-2">
              {recap.decisions.map((d, i) => (
                <div key={i} className="rounded-lg border border-border bg-card p-3">
                  {d.category.length > 0 ? (
                    <span className={`${BADGE} bg-accent-soft text-accent`}>{d.category}</span>
                  ) : null}
                  <p className={`text-sm text-fg${d.category.length > 0 ? ' mt-1.5' : ''}`}>{d.text}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {recap.action_items.length > 0 ? (
          <div>
            <h3 className={SECTION_LABEL}>Action items</h3>
            <ul className="space-y-2">
              {recap.action_items.map((a, i) => {
                const ts = mmss(a.timestampMs);
                return (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0 flex-1 text-fg">{a.text}</span>
                    {a.assignee !== null ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                        <Avatar name={a.assignee} />
                        {a.assignee}
                      </span>
                    ) : null}
                    {ts !== null ? (
                      <span className={`${BADGE} shrink-0 bg-bg/60 tabular-nums text-muted`}>{ts}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>

      <RecapRail participants={recap.participants} regenerate={regenerate} />
    </div>
  );
}

function StatCards({ recap }: { recap: StructuredRecap }): ReactElement {
  const stats: { label: string; value: number; testid: string }[] = [
    { label: 'Key topics', value: recap.topics.length, testid: 'stat-topics' },
    { label: 'Decisions', value: recap.decisions.length, testid: 'stat-decisions' },
    { label: 'Action items', value: recap.action_items.length, testid: 'stat-actions' },
    { label: 'Attendees', value: recap.participants.length, testid: 'stat-attendees' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.testid} className="rounded-lg border border-border bg-card px-4 py-3">
          <div data-testid={s.testid} className="text-2xl font-semibold tabular-nums text-fg">
            {s.value}
          </div>
          <div className="mt-0.5 text-xs uppercase tracking-wider text-muted">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Right rail: participants (collapsed when none — local-audio) + the generated-by footer + Regenerate. */
function RecapRail({
  participants,
  regenerate,
}: {
  participants: readonly RecapParticipant[];
  regenerate: ReactNode;
}): ReactElement {
  return (
    <aside className="space-y-5 lg:border-l lg:border-border lg:pl-6">
      {participants.length > 0 ? (
        <div>
          <h3 className={SECTION_LABEL}>Participants</h3>
          <ul className="space-y-1.5" data-testid="participant-list">
            {participants.map((p) => (
              <li key={p.name} className="flex items-center gap-2 text-sm text-fg">
                <Avatar name={p.name} />
                {p.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted">
          Recap generated by Risezome from the meeting transcript.
        </p>
        {regenerate !== null ? <div className="flex justify-start">{regenerate}</div> : null}
      </div>
    </aside>
  );
}

/** A small circular initials avatar. */
function Avatar({ name }: { name: string }): ReactElement {
  const initials = name
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
      {initials}
    </span>
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
