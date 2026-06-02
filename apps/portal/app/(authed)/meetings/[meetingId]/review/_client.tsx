'use client';

import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
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

/**
 * Post-meeting review (U8). Mirrors the live view's styling: a generated
 * whole-meeting recap on top, then the full transcript with the utterances
 * that triggered an AI summary highlighted — click one to open its synthesis
 * card (the same hud-ui card the live page renders). Static: seeds the reducer
 * once, no Realtime.
 */

export type RecapStatus = 'generating' | 'done' | 'failed' | null;

export interface ReviewClientProps {
  title: string;
  status: string;
  startedAtIso: string | null;
  endedAtIso: string | null;
  recapText: string | null;
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
      pinned: s.pinned,
      pinnedAt: s.pinnedAt,
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
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <a href="/upcoming" className="text-xs text-muted hover:text-fg">
          ← Upcoming
        </a>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{props.title}</h1>
        <p className="mt-1.5 text-sm text-muted">
          <StatusBadge status={props.status} /> · {formatRange(props.startedAtIso, props.endedAtIso)}
        </p>
      </header>

      <RecapSection text={props.recapText} status={props.recapStatus} />

      {props.initialTranscript.length === 0 ? (
        <p className="text-sm text-muted">No transcript was captured for this meeting.</p>
      ) : (
        <AppStateProvider initial={seeded}>
          <ReviewBody anchorMap={props.anchorMap} transcript={props.initialTranscript} />
        </AppStateProvider>
      )}
    </div>
  );
}

function ReviewBody({
  anchorMap,
  transcript,
}: {
  anchorMap: Record<string, string>;
  transcript: TranscriptUtterance[];
}): ReactElement {
  const [activeSynthesisId, setActiveSynthesisId] = useState<string | null>(null);
  const anchored = useMemo(() => new Set(Object.keys(anchorMap)), [anchorMap]);

  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
      <section className="min-w-0">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Transcript</h2>
        <TranscriptPanel
          utterances={transcript}
          anchoredUtteranceIds={anchored}
          onAnchorClick={(utteranceId) => setActiveSynthesisId(anchorMap[utteranceId] ?? null)}
        />
      </section>
      <section className="min-w-0 md:sticky md:top-8 md:self-start">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Summary</h2>
        {activeSynthesisId !== null ? (
          <ActiveSynthesis synthesisId={activeSynthesisId} />
        ) : (
          <p className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-6 text-sm text-muted">
            {anchored.size > 0
              ? 'Click a highlighted moment in the transcript to see the summary it generated.'
              : 'No summaries were generated in this meeting.'}
          </p>
        )}
      </section>
    </div>
  );
}

function ActiveSynthesis({ synthesisId }: { synthesisId: string }): ReactElement | null {
  const state = useAppState();
  const record = state.syntheses.get(synthesisId);
  if (record === undefined) return null;
  return <SynthesisStreamItem syn={record} />;
}

function RecapSection({ text, status }: { text: string | null; status: RecapStatus }): ReactElement {
  let body: ReactNode;
  if (status === 'done' && text !== null && text.length > 0) {
    body = <RecapMarkdown text={text} />;
  } else if (status === 'generating') {
    body = <p className="text-sm text-muted">Generating the meeting recap…</p>;
  } else if (status === 'failed') {
    body = <p className="text-sm text-muted">The recap could not be generated for this meeting.</p>;
  } else {
    body = <p className="text-sm text-muted">No recap available for this meeting.</p>;
  }
  return (
    <section className="mb-8 rounded-xl border border-accent/30 bg-accent-soft/30 p-5">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-accent">Meeting recap</div>
      {body}
    </section>
  );
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
