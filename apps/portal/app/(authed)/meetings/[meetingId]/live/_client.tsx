'use client';

import { useMemo, type ReactElement } from 'react';
import {
  AppStateProvider,
  CardStream,
  EmptyState,
  PinnedSection,
  SynthesisAnnounce,
  SynthesisStream,
  initialAppState,
  useAppState,
  type AppState,
  type CardEvent,
  type CardRecord,
  type SynthesisRecord,
} from '@risezome/hud-ui';
import type { InitialSynthesis } from './page';

export type MeetingStatus =
  | 'launching'
  | 'awaiting_recall'
  | 'joining'
  | 'waiting_room'
  | 'recording'
  | 'failed';

interface Props {
  meetingId: string;
  status: MeetingStatus;
  title: string;
  errorCode: string | null;
  errorMessage: string | null;
  startedAtIso: string | null;
  initialCards: CardEvent[];
  initialSyntheses: InitialSynthesis[];
}

/**
 * Client wrapper for the live page. Seeds the AppStateProvider reducer
 * with the server-fetched cards + syntheses; the HUD components then
 * render from that state. U11b adds Realtime subscription on top of
 * this same provider so live deltas flow through the same reducer
 * actions.
 *
 * Status-driven rendering:
 *   - recording      → full HUD (card + synthesis streams)
 *   - launching..waiting_room → joining shell with rotating EmptyState
 *   - failed         → diagnostic banner with error_code + message
 */
export function LiveMeetingClient(props: Props): ReactElement {
  const seeded = useMemo<AppState>(
    () => seedState(props.initialCards, props.initialSyntheses, props.status),
    [props.initialCards, props.initialSyntheses, props.status],
  );

  if (props.status === 'failed') {
    return (
      <FailureShell
        title={props.title}
        errorCode={props.errorCode}
        errorMessage={props.errorMessage}
      />
    );
  }

  if (props.status !== 'recording') {
    return <JoiningShell status={props.status} title={props.title} />;
  }

  return (
    <AppStateProvider initial={seeded}>
      <RecordingShell title={props.title} startedAtIso={props.startedAtIso} />
    </AppStateProvider>
  );
}

function seedState(
  cards: CardEvent[],
  syntheses: InitialSynthesis[],
  status: MeetingStatus,
): AppState {
  const cardMap = new Map<string, CardRecord>();
  // Cards arrived from the server in surfaced_at DESC; the reducer's
  // map is insertion-ordered and the HUD reads it as-is, so we reverse
  // here to preserve newest-first display.
  for (const card of cards) {
    cardMap.set(card.cardId, { card, pinned: false });
  }

  const synthMap = new Map<string, SynthesisRecord>();
  for (const s of syntheses) {
    synthMap.set(s.synthesisId, {
      synthesisId: s.synthesisId,
      sourceCardIds: s.sourceCardIds,
      traceId: s.traceId,
      accumulatedText: s.accumulatedText,
      streaming: s.status === 'running',
      citations: s.citations,
      ...(s.stopReason !== undefined ? { stopReason: s.stopReason } : {}),
      ...(s.ttftMs !== undefined ? { ttftMs: s.ttftMs } : {}),
      ...(s.latencyMs !== undefined ? { latencyMs: s.latencyMs } : {}),
      ...(s.usage !== undefined ? { usage: s.usage } : {}),
    });
  }

  return {
    ...initialAppState,
    status: 'disconnected',
    meeting: status === 'recording' ? 'live' : 'idle',
    cards: cardMap,
    syntheses: synthMap,
  };
}

function RecordingShell({
  title,
  startedAtIso,
}: {
  title: string;
  startedAtIso: string | null;
}): ReactElement {
  const minutesIn = startedAtIso !== null
    ? Math.max(0, Math.round((Date.now() - new Date(startedAtIso).getTime()) / 60_000))
    : null;

  return (
    <div className="mx-auto flex h-dvh max-w-5xl flex-col px-6 py-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-rose-400" />
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            Live · Risezome in the meeting
            {minutesIn !== null ? <> · {minutesIn}m in</> : null}
          </p>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="min-h-0 overflow-y-auto">
          <PinnedSection />
          <CardStream />
        </div>
        <aside className="min-h-0 overflow-y-auto rounded-xl border border-border bg-card p-4">
          <SynthesisStream />
        </aside>
      </div>

      <SynthesisAnnouncer />
    </div>
  );
}

/** Bridges the reducer's `lastSynthesisAnnounce` slot into the hud-ui
 *  SynthesisAnnounce component, which expects an explicit `text` prop. */
function SynthesisAnnouncer(): ReactElement {
  const state = useAppState();
  return <SynthesisAnnounce text={state.lastSynthesisAnnounce} />;
}

function JoiningShell({
  status,
  title,
}: {
  status: MeetingStatus;
  title: string;
}): ReactElement {
  const heading =
    status === 'launching'
      ? 'Launching the Risezome bot…'
      : status === 'awaiting_recall'
      ? 'Waiting for Recall.ai to dial in…'
      : status === 'joining'
      ? 'Risezome is joining your meeting…'
      : 'Risezome is in the waiting room…';

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col px-6 py-12">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-accent">{heading}</p>
      </header>

      <div className="flex flex-1 items-center justify-center">
        <div className="w-full">
          <EmptyState />
        </div>
      </div>
    </div>
  );
}

function FailureShell({
  title,
  errorCode,
  errorMessage,
}: {
  title: string;
  errorCode: string | null;
  errorMessage: string | null;
}): ReactElement {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-rose-400">Bot launch failed</p>
      </header>

      <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-6">
        <p className="text-sm text-rose-200">
          {errorMessage ?? 'The bot could not be launched. Check the meeting URL and retry from the Upcoming page.'}
        </p>
        {errorCode !== null ? (
          <p className="mt-3 font-mono text-xs text-rose-300/80">code: {errorCode}</p>
        ) : null}
      </div>

      <div className="mt-6 text-center">
        <a
          href="/upcoming"
          className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-fg hover:bg-accent-soft"
        >
          ← Back to Upcoming
        </a>
      </div>
    </div>
  );
}
