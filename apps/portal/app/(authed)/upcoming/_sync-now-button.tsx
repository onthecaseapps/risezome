'use client';

import { useTransition, useState, type ReactElement } from 'react';
import { syncNowAction } from './sync-now-action';

/**
 * Triggers an immediate sync-calendar event. After the action returns
 * we delay a beat then call router.refresh() so the run has time to
 * upsert before the page re-fetches. (The action revalidates the path,
 * but Inngest runs are async — the row writes happen after the action
 * returns.)
 */
export function SyncNowButton(): ReactElement {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastFired, setLastFired] = useState<number | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await syncNowAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLastFired(Date.now());
    });
  }

  const seconds = lastFired === null ? null : Math.max(0, Math.floor((Date.now() - lastFired) / 1000));

  return (
    <div className="flex items-center gap-2">
      {seconds !== null && error === null ? (
        <span className="text-xs text-muted">Synced {seconds === 0 ? 'just now' : `${seconds}s ago`}</span>
      ) : null}
      {error !== null ? <span className="text-xs text-rose-400">{error.slice(0, 80)}</span> : null}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg hover:bg-accent-soft disabled:opacity-50"
      >
        {pending ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}
