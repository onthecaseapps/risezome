'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { pollMeetingStatusesAction } from './poll-status-action';
import type { MeetingRow } from './_meetings-lookup';

/**
 * Live-status layer for the Upcoming page. The server renders the initial
 * meeting status per row; this provider then polls a server action on an
 * interval and patches any row whose status changed — so a bot launching,
 * joining, or going live advances the row's chip + CTA without a manual
 * refresh (the page's previous behaviour). Polling (not Realtime) is the
 * right fit for a list of many meetings: status changes a handful of times
 * per meeting and a single cheap query covers every row.
 */

const POLL_MS = 5000;

type StatusMap = Record<string, MeetingRow>;

const LiveStatusContext = createContext<StatusMap>({});

export function LiveStatusProvider({
  eventIds,
  initial,
  children,
}: {
  eventIds: readonly string[];
  initial: StatusMap;
  children: ReactNode;
}): ReactElement {
  const [statuses, setStatuses] = useState<StatusMap>(initial);
  // Stable primitive dep so the effect doesn't re-subscribe on every render.
  const key = eventIds.join(',');

  useEffect(() => {
    if (eventIds.length === 0) return;
    let cancelled = false;
    const ids = key.length > 0 ? key.split(',') : [];
    const tick = async (): Promise<void> => {
      try {
        const next = await pollMeetingStatusesAction(ids);
        if (!cancelled) setStatuses(next);
      } catch {
        // Best-effort liveness; the initial server render + manual refresh
        // remain the floor. Swallow transient action failures.
      }
    };
    const interval = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <LiveStatusContext.Provider value={statuses}>{children}</LiveStatusContext.Provider>;
}

export function useMeetingLive(eventId: string): MeetingRow | null {
  return useContext(LiveStatusContext)[eventId] ?? null;
}

/* ---------- status derivation (moved from the server page) ---------- */

export interface EventTiming {
  readonly start_at: string;
  readonly end_at: string;
  readonly bot_optin: boolean;
}

interface RowStatus {
  label: string;
  tone: 'live' | 'launching' | 'joining' | 'soon' | 'later' | 'failed';
  tooltip?: string;
}

/**
 * Pick the row's status chip. Priority order matters — bot lifecycle states
 * dominate the time-based label so the user always sees the most useful
 * information. (Moved verbatim from the server page so the live chip and the
 * initial server render agree.)
 */
export function describeRowStatus(event: EventTiming, meeting: MeetingRow | null): RowStatus | null {
  const now = Date.now();
  const start = new Date(event.start_at).getTime();
  const end = new Date(event.end_at).getTime();

  if (meeting !== null) {
    if (meeting.status === 'recording') {
      const mins =
        meeting.started_at !== null
          ? Math.max(0, Math.round((now - new Date(meeting.started_at).getTime()) / 60_000))
          : 0;
      return { label: `Live now${mins > 0 ? ` · ${mins}m in` : ''}`, tone: 'live' };
    }
    if (meeting.status === 'failed') {
      return {
        label: 'Bot launch failed',
        tone: 'failed',
        tooltip: meeting.error_message ?? 'Check the meeting URL and try toggling off + on',
      };
    }
    if (
      meeting.status === 'launching' ||
      meeting.status === 'awaiting_recall' ||
      meeting.status === 'joining' ||
      meeting.status === 'waiting_room'
    ) {
      return { label: 'Bot joining…', tone: 'joining' };
    }
    // 'completed' falls through to time-based handling
  }

  if (start <= now && end > now) {
    return event.bot_optin
      ? { label: 'Starting now', tone: 'launching' }
      : { label: 'Live (no bot)', tone: 'later' };
  }

  if (event.bot_optin && start > now) {
    const diffMin = Math.round((start - now) / 60_000);
    if (diffMin <= 15) return { label: `Bot launching in ${String(diffMin)} min`, tone: 'launching' };
    if (diffMin <= 60) return { label: `Bot scheduled · in ${String(diffMin)} min`, tone: 'soon' };
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return { label: `Bot scheduled · in ${String(diffHr)}h`, tone: 'soon' };
    return { label: 'Bot scheduled', tone: 'soon' };
  }

  const diffMin = Math.round((start - now) / 60_000);
  if (diffMin <= 0) return null;
  if (diffMin <= 60) return { label: `In ${String(diffMin)} min`, tone: 'soon' };
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return { label: `In ${String(diffHr)} h`, tone: 'later' };
  return null;
}

const TONE_CLASS: Record<RowStatus['tone'], string> = {
  live: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 animate-pulse',
  launching: 'bg-accent-soft text-accent',
  joining: 'bg-accent-soft text-accent',
  soon: 'bg-accent-soft text-accent',
  later: 'bg-bg/60 text-muted',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

/** Live status chip: recomputes from the polled meeting status + the clock. */
export function LiveStatusChip({ event, eventId }: { event: EventTiming; eventId: string }): ReactElement | null {
  const meeting = useMeetingLive(eventId);
  const status = describeRowStatus(event, meeting);
  if (status === null) return null;
  return (
    <span
      title={status.tooltip}
      suppressHydrationWarning
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${TONE_CLASS[status.tone]}`}
    >
      {status.label}
    </span>
  );
}

/** Live "Open live view" / "View meeting" CTA, driven by the polled status. */
export function LiveMeetingCta({ eventId }: { eventId: string }): ReactElement | null {
  const meeting = useMeetingLive(eventId);
  if (meeting === null) return null;
  const showButton =
    meeting.status === 'recording' ||
    meeting.status === 'joining' ||
    meeting.status === 'awaiting_recall' ||
    meeting.status === 'launching' ||
    meeting.status === 'waiting_room' ||
    meeting.status === 'failed';
  if (!showButton) return null;
  const recording = meeting.status === 'recording';
  return (
    <a
      href={`/meetings/${meeting.meeting_id}/live`}
      className="inline-flex h-8 items-center rounded-md border border-border bg-card px-2.5 text-xs font-medium text-fg hover:bg-accent-soft"
      aria-label={recording ? 'Open live view' : 'Open meeting'}
    >
      {recording ? 'Open live view' : 'View meeting'}
    </a>
  );
}
