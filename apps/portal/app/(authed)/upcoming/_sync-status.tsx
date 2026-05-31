'use client';

import { useEffect, useState, useTransition, type ReactElement } from 'react';
import { syncNowAction } from './sync-now-action';

/**
 * Status indicator that doubles as a manual resync trigger.
 *
 * Renders as: "Calendar synced N min ago" with a refresh icon. Clicking
 * fires the sync action; while pending the label flips to "Syncing…".
 * The "X min ago" counter ticks up locally so the user gets a sense of
 * staleness without a server round-trip.
 *
 * `lastSyncedAtIso` is the server-side starting point — typically
 * max(updated_at) on the user's calendar_events rows, or the user's
 * Google-token updated_at if there are no events.
 */
export function SyncStatus({
  lastSyncedAtIso,
}: {
  lastSyncedAtIso: string | null;
}): ReactElement {
  const [base, setBase] = useState<number | null>(
    lastSyncedAtIso === null ? null : new Date(lastSyncedAtIso).getTime(),
  );
  const [tick, setTick] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Re-render every 30s so "5 min ago" stays honest. Cheap.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  function handleClick() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await syncNowAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBase(Date.now());
    });
  }

  const label = pending
    ? 'Syncing…'
    : base === null
    ? 'Never synced'
    : `Calendar synced ${formatRelativeAgo(base, tick)}`;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        title="Click to sync now"
        className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg disabled:cursor-wait"
      >
        <RefreshIcon className={pending ? 'animate-spin' : ''} />
        {label}
      </button>
      {error !== null ? (
        <span className="text-[11px] text-rose-400">{error.slice(0, 80)}</span>
      ) : null}
    </div>
  );
}

function formatRelativeAgo(then: number, _tick: number): string {
  const diff = Date.now() - then;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function RefreshIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}
