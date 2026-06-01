'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { reindexSourceAction } from './reindex-action';

/**
 * Per-row actions for a GitHub source: a kebab (⋮) menu with delta/full
 * Reindex and "Manage repo settings". The latter reveals the branch panel
 * below the row via `onManageSettings` — matching the Trello/Atlassian
 * "Manage …" pattern so all connectors share one manage UX.
 *
 * The menu is a native click-toggle (an outside-click overlay closes it) so we
 * don't pull in a popover library.
 */
export function SourceActions({
  sourceId,
  busy,
  onManageSettings,
}: {
  sourceId: string;
  busy: boolean;
  onManageSettings?: (() => void) | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setOpen(false);
    setError(null);
  }

  function handleReindex(reindexMode: 'delta' | 'full'): void {
    setError(null);
    const fd = new FormData();
    fd.set('sourceId', sourceId);
    fd.set('mode', reindexMode);
    startTransition(async () => {
      const result = await reindexSourceAction(fd);
      if (!result.ok) setError(humanError(result.error));
      else close();
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Source actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        disabled={pending}
        className="rounded-md p-1.5 text-muted hover:bg-bg disabled:opacity-40"
      >
        <KebabIcon />
      </button>

      {open ? (
        <>
          {/* Transparent overlay catches outside clicks to close the menu. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={close}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => handleReindex('delta')}
              disabled={busy || pending}
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
              title={busy ? 'Indexer is already running — wait for it to finish' : undefined}
            >
              {pending ? <Spinner /> : <RetryIcon />}
              <span className="flex flex-col">
                <span>{pending ? 'Queuing…' : 'Reindex (delta)'}</span>
                <span className="text-[11px] text-muted">New &amp; changed only</span>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleReindex('full')}
              disabled={busy || pending}
              className="flex w-full items-start gap-2 border-t border-border px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
              title={busy ? 'Indexer is already running — wait for it to finish' : undefined}
            >
              {pending ? <Spinner /> : <RetryIcon />}
              <span className="flex flex-col">
                <span>{pending ? 'Queuing…' : 'Reindex (full)'}</span>
                <span className="text-[11px] text-muted">Also removes deleted items</span>
              </span>
            </button>
            {onManageSettings !== undefined ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onManageSettings();
                  close();
                }}
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-fg hover:bg-bg"
              >
                <GearIcon />
                Manage repo settings
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {error !== null ? (
        <span className="absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function humanError(code: string): string {
  if (code === 'missing_source_id') return 'Internal: missing source id';
  if (code === 'source_not_found') return 'Source not found';
  return `Failed (${code})`;
}

function KebabIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function RetryIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function GearIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function Spinner(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
