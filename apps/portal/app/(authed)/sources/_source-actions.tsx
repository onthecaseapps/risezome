'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { reindexSourceAction } from './reindex-action';

/**
 * Per-row actions for the sources list. Today: a kebab menu with one
 * working item (Reindex). The menu is a native click-toggle (close on
 * outside click is handled by a transparent overlay) so we don't pull in
 * a popover library for one button.
 *
 * Disabling rules:
 *   - busy (status pending|indexing) → reindex disabled with hint
 *   - in-flight POST (useTransition pending) → spinner + disabled
 */
export function SourceActions({
  sourceId,
  busy,
}: {
  sourceId: string;
  busy: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleReindex() {
    setError(null);
    const fd = new FormData();
    fd.set('sourceId', sourceId);
    startTransition(async () => {
      const result = await reindexSourceAction(fd);
      if (!result.ok) {
        setError(humanError(result.error));
      } else {
        setOpen(false);
      }
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Source actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleReindex}
              disabled={busy || pending}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
              title={busy ? 'Indexer is already running — wait for it to finish' : undefined}
            >
              {pending ? <Spinner /> : <RetryIcon />}
              {pending ? 'Queuing…' : 'Reindex'}
            </button>
          </div>
        </>
      ) : null}

      {error !== null ? (
        <span className="absolute right-0 top-full mt-2 whitespace-nowrap rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-400">
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

function Spinner(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
