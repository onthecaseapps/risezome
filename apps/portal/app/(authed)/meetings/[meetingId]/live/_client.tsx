'use client';

import { useEffect, useMemo, useState, useTransition, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { retryFailedLaunchAction } from './retry-launch-server';
import {
  AppStateProvider,
  CardActionsProvider,
  EmptyState,
  PinnedSynthesesSection,
  SynthesisActionsProvider,
  SynthesisAnnounce,
  SynthesisStream,
  LiveTranscriptPanel,
  SYNTHESIS_PAUSED_THRESHOLD,
  initialAppState,
  useAppDispatch,
  useAppState,
  type AppState,
  type CardActions,
  type CardRecord,
  type SynthesisActions,
  type SynthesisRecord,
  type TranscriptUtterance,
} from '@risezome/hud-ui';
import {
  useRealtimeMeetingChannel,
  type BroadcastedStatus,
} from '../../../../_lib/realtime-meeting-channel';
import { pinCardAction, dismissCardAction } from './card-actions-server';
import { pinSynthesisAction } from './synthesis-actions-server';
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
  orgId: string;
  status: MeetingStatus;
  title: string;
  errorCode: string | null;
  errorMessage: string | null;
  startedAtIso: string | null;
  initialCards: CardRecord[];
  initialSyntheses: InitialSynthesis[];
  initialTranscript: TranscriptUtterance[];
  /** Max meeting_events.event_id at SSR seed time — seeds the poll cursor so
   *  mount doesn't replay the whole event log. */
  initialLastEventId?: number;
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
    () => seedState(props.initialCards, props.initialSyntheses, props.initialTranscript, props.status),
    [props.initialCards, props.initialSyntheses, props.initialTranscript, props.status],
  );

  // Failed meetings don't need Realtime — the bot never connected. Render
  // statically and bail out.
  if (props.status === 'failed') {
    return (
      <FailureShell
        meetingId={props.meetingId}
        title={props.title}
        errorCode={props.errorCode}
        errorMessage={props.errorMessage}
      />
    );
  }

  // For everything else, always mount the provider + subscription so the
  // shell can swap when the bot dials in (joining → recording) without
  // a reload.
  return (
    <AppStateProvider initial={seeded}>
      <RealtimeWrapper
        meetingId={props.meetingId}
        orgId={props.orgId}
        title={props.title}
        startedAtIso={props.startedAtIso}
        initialStatus={props.status}
        initialLastEventId={props.initialLastEventId ?? 0}
      />
    </AppStateProvider>
  );
}

function RealtimeWrapper({
  meetingId,
  orgId,
  title,
  startedAtIso,
  initialStatus,
  initialLastEventId,
}: {
  meetingId: string;
  orgId: string;
  title: string;
  startedAtIso: string | null;
  initialStatus: MeetingStatus;
  initialLastEventId: number;
}): ReactElement {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const channel = useRealtimeMeetingChannel({ meetingId, orgId, dispatch, initialLastEventId });
  const effectiveStatus: BroadcastedStatus = channel.liveMeetingStatus ?? initialStatus;

  // F5: the meeting ended — hand off to the recap. The channel hook has
  // already stopped its polls + unsubscribed on the terminal status.
  useEffect(() => {
    if (effectiveStatus === 'completed') {
      router.replace(`/meetings/${meetingId}/review`);
    }
  }, [effectiveStatus, meetingId, router]);

  // Pin/dismiss handlers. Each one optimistically dispatches a reducer
  // action FIRST (so the UI snaps immediately), then calls the server
  // action. On server-side failure we roll back via the opposite
  // dispatch. The HUD's HudCard captures errors via its own
  // useTransition state so the button shows a brief error label.
  const cardActions = useMemo<CardActions>(
    () => ({
      pin: async (cardId: string) => {
        dispatch({ type: 'cardPinned', cardId, pinned: true });
        const result = await pinCardAction(cardId, true);
        if (!result.ok) {
          dispatch({ type: 'cardPinned', cardId, pinned: false });
          throw new Error(result.error);
        }
      },
      unpin: async (cardId: string) => {
        dispatch({ type: 'cardPinned', cardId, pinned: false });
        const result = await pinCardAction(cardId, false);
        if (!result.ok) {
          dispatch({ type: 'cardPinned', cardId, pinned: true });
          throw new Error(result.error);
        }
      },
      dismiss: async (cardId: string) => {
        // Optimistic: dispatch a retraction so the card disappears
        // immediately. Server confirms; on failure we'd need to re-add,
        // but for V1 we surface the error and let the user reload.
        dispatch({
          type: 'cardRetracted',
          retracted: { cardId, reason: 'manual-dismiss' },
        });
        const result = await dismissCardAction(cardId);
        if (!result.ok) throw new Error(result.error);
      },
    }),
    [dispatch],
  );

  // Synthesis-level pin (plan U5). Same optimistic-then-server pattern
  // as cardActions; rollback on failure restores the prior pin state.
  // No broadcast in V1 — cross-tab sync deferred per Scope Boundaries.
  const synthesisActions = useMemo<SynthesisActions>(
    () => ({
      pin: async (synthesisId: string) => {
        const at = new Date().toISOString();
        dispatch({ type: 'synthesisPinned', synthesisId, pinned: true, pinnedAt: at });
        const result = await pinSynthesisAction(synthesisId, true);
        if (!result.ok) {
          dispatch({ type: 'synthesisPinned', synthesisId, pinned: false, pinnedAt: null });
          throw new Error(result.error);
        }
      },
      unpin: async (synthesisId: string) => {
        // Capture prior pinnedAt for rollback so we don't lose it on a
        // server failure.
        dispatch({ type: 'synthesisPinned', synthesisId, pinned: false, pinnedAt: null });
        const result = await pinSynthesisAction(synthesisId, false);
        if (!result.ok) {
          dispatch({
            type: 'synthesisPinned',
            synthesisId,
            pinned: true,
            pinnedAt: new Date().toISOString(),
          });
          throw new Error(result.error);
        }
      },
    }),
    [dispatch],
  );

  if (effectiveStatus === 'recording') {
    return (
      <CardActionsProvider actions={cardActions}>
        <SynthesisActionsProvider actions={synthesisActions}>
          <RecordingShell title={title} startedAtIso={startedAtIso} channelStatus={channel.status} />
        </SynthesisActionsProvider>
      </CardActionsProvider>
    );
  }
  if (effectiveStatus === 'failed') {
    // Shouldn't happen — we'd have rendered FailureShell above. But
    // defensive in case a broadcast flips us here later.
    return <JoiningShell status="failed" title={title} channelStatus={channel.status} />;
  }
  return <JoiningShell status={effectiveStatus} title={title} channelStatus={channel.status} />;
}

function seedState(
  cards: CardRecord[],
  syntheses: InitialSynthesis[],
  transcript: TranscriptUtterance[],
  status: MeetingStatus,
): AppState {
  const cardMap = new Map<string, CardRecord>();
  for (const rec of cards) {
    cardMap.set(rec.card.cardId, rec);
  }

  const synthMap = new Map<string, SynthesisRecord>();
  // The server query orders created_at DESC, but the reducer's map (and the
  // live reducer path) inserts chronologically ASC — SynthesisStream
  // `.reverse()`s for newest-first display. Iterate reversed to match.
  for (const s of [...syntheses].reverse()) {
    synthMap.set(s.synthesisId, {
      synthesisId: s.synthesisId,
      sourceCardIds: s.sourceCardIds,
      traceId: s.traceId,
      accumulatedText: s.accumulatedText,
      streaming: s.status === 'running',
      citations: s.citations,
      pinned: s.pinned ?? false,
      pinnedAt: s.pinnedAt ?? null,
      ...(s.triggerUtteranceId != null ? { triggerUtteranceId: s.triggerUtteranceId } : {}),
      ...(s.stopReason !== undefined ? { stopReason: s.stopReason } : {}),
      ...(s.ttftMs !== undefined ? { ttftMs: s.ttftMs } : {}),
      ...(s.latencyMs !== undefined ? { latencyMs: s.latencyMs } : {}),
      ...(s.usage !== undefined ? { usage: s.usage } : {}),
    });
  }

  const transcriptMap = new Map<string, TranscriptUtterance>();
  for (const u of transcript) {
    transcriptMap.set(u.utteranceId, u);
  }

  return {
    ...initialAppState,
    status: 'disconnected',
    meeting: status === 'recording' ? 'live' : 'idle',
    cards: cardMap,
    syntheses: synthMap,
    transcript: transcriptMap,
  };
}

function RecordingShell({
  title,
  startedAtIso,
  channelStatus,
}: {
  title: string;
  startedAtIso: string | null;
  channelStatus: 'idle' | 'connecting' | 'subscribed' | 'errored';
}): ReactElement {
  // F11: drive the elapsed label from a timer — computed in render alone it
  // would freeze at its mount value.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const minutesIn = startedAtIso !== null
    ? Math.max(0, Math.round((nowMs - new Date(startedAtIso).getTime()) / 60_000))
    : null;
  const state = useAppState();
  // U8: synthesis paused pill renders when N consecutive failures
  // (errors + refusals) have piled up without a successful done. Clears
  // on the next synthesisDone. Keeps the user from seeing an empty
  // page in silence when synthesis silently breaks (rate limit, key
  // rotation, provider incident).
  const isPaused = state.synthesisFailureStreak >= SYNTHESIS_PAUSED_THRESHOLD;

  return (
    <div className="mx-auto flex h-dvh max-w-6xl flex-col px-6 py-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-rose-400" />
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
            {isPaused && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300"
                role="status"
                aria-live="polite"
                title="No successful synthesis in the last few retrievals — check the bot worker / Anthropic key."
              >
                Summaries paused
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            Live · Risezome in the meeting
            {minutesIn !== null ? <> · {minutesIn}m in</> : null}
            {channelStatus !== 'subscribed' ? (
              <span className="ml-2 text-amber-400">· {channelStatus}</span>
            ) : null}
          </p>
        </div>
      </header>

      {/* Transcript on the left, AI Summary cards on the right. Stacks
          (transcript above cards) on narrow viewports. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 md:grid-cols-2">
        <section className="flex min-h-0 flex-col">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Transcript</h2>
          <LiveTranscriptPanel />
        </section>
        <section className="flex min-h-0 flex-col overflow-y-auto pr-2 [scrollbar-gutter:stable]">
          <PinnedSynthesesSection />
          <SynthesisStream />
        </section>
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
  channelStatus,
}: {
  status: BroadcastedStatus;
  title: string;
  channelStatus?: 'idle' | 'connecting' | 'subscribed' | 'errored';
}): ReactElement {
  const heading =
    status === 'launching'
      ? 'Launching the Risezome bot…'
      : status === 'awaiting_recall'
      ? 'Waiting for Recall.ai to dial in…'
      : status === 'joining'
      ? 'Risezome is joining your meeting…'
      : status === 'waiting_room'
      ? 'Risezome is in the waiting room…'
      : status === 'completed'
      ? 'Meeting ended — taking you to the recap…'
      : 'Working on it…';

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col px-6 py-12">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-accent">
          {heading}
          {channelStatus !== undefined && channelStatus !== 'subscribed' ? (
            <span className="ml-2 text-xs text-muted">· {channelStatus}</span>
          ) : null}
        </p>
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
  meetingId,
  title,
  errorCode,
  errorMessage,
}: {
  meetingId: string;
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

      <div className="mt-6 flex items-center justify-center gap-2">
        <FailureRetryButton meetingId={meetingId} />
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

function FailureRetryButton({ meetingId }: { meetingId: string }): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState(false);

  function handleRetry(): void {
    setError(null);
    startTransition(async () => {
      const result = await retryFailedLaunchAction(meetingId);
      if (!result.ok) {
        setError(humanError(result.error));
        return;
      }
      setFired(true);
      // The retry fires a new launch which creates a NEW meetings row.
      // Bounce back to /upcoming where the new row will appear with the
      // updated status. The old failed row stays in the DB for history
      // but is no longer the active one for this calendar event.
      router.push('/upcoming?notice=retry_fired');
    });
  }

  if (fired) {
    return (
      <span className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300">
        Retry fired
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleRetry}
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-press disabled:opacity-60"
      >
        {pending ? 'Retrying…' : 'Retry launch'}
      </button>
      {error !== null ? (
        <span className="text-xs text-rose-400">{error}</span>
      ) : null}
    </>
  );
}

function humanError(code: string): string {
  const map: Record<string, string> = {
    meeting_not_found: 'Meeting record not found',
    not_failed: 'This meeting isn\'t in a failed state',
    no_calendar_event: 'Calendar event has been deleted',
    calendar_event_deleted: 'Calendar event was removed in Google Calendar',
  };
  return map[code] ?? `Retry failed (${code})`;
}
