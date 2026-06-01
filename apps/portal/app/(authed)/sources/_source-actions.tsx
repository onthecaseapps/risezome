'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { reindexSourceAction } from './reindex-action';
import { listRepoBranchesAction, setRepoBranchAction } from './repo-settings-action';

/**
 * Per-row actions for a GitHub source: a kebab (⋮) menu with Reindex and
 * "Manage repo settings". The latter swaps the dropdown into a branch picker
 * (the indexer reads `sources.default_branch`) so the user can index a
 * different branch — re-indexing on save.
 *
 * The menu is a native click-toggle (an outside-click overlay closes it) so we
 * don't pull in a popover library.
 */
export function SourceActions({
  sourceId,
  busy,
  currentBranch,
}: {
  sourceId: string;
  busy: boolean;
  currentBranch?: string | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'settings'>('menu');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Branch picker state.
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(currentBranch ?? null);
  const [saving, startSave] = useTransition();

  function close(): void {
    setOpen(false);
    setMode('menu');
    setError(null);
    setBranchError(null);
  }

  function handleReindex(): void {
    setError(null);
    const fd = new FormData();
    fd.set('sourceId', sourceId);
    startTransition(async () => {
      const result = await reindexSourceAction(fd);
      if (!result.ok) setError(humanError(result.error));
      else close();
    });
  }

  function openSettings(): void {
    setMode('settings');
    setBranches(null);
    setBranchError(null);
    setSelected(currentBranch ?? null);
    startTransition(async () => {
      const res = await listRepoBranchesAction(sourceId);
      if (!res.ok) {
        setBranchError(branchErrorMessage(res.error));
        setBranches([]);
        return;
      }
      setBranches(res.branches);
      setSelected((prev) => prev ?? res.current);
    });
  }

  function handleSaveBranch(): void {
    if (selected === null || selected === currentBranch) return;
    setBranchError(null);
    startSave(async () => {
      const res = await setRepoBranchAction(sourceId, selected);
      if (!res.ok) setBranchError(branchErrorMessage(res.error));
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
          {mode === 'menu' ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
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
              <button
                type="button"
                role="menuitem"
                onClick={openSettings}
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-fg hover:bg-bg"
              >
                <GearIcon />
                Manage repo settings
              </button>
            </div>
          ) : (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
            >
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  aria-label="Back"
                  className="rounded p-0.5 text-muted hover:bg-bg hover:text-fg"
                >
                  <BackIcon />
                </button>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Index branch
                </span>
              </div>

              <div className="max-h-60 overflow-y-auto p-1.5">
                {branches === null ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted">
                    <Spinner />
                    Loading branches…
                  </div>
                ) : branches.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted">
                    {branchError ?? 'No branches found.'}
                  </div>
                ) : (
                  <ul className="flex flex-col">
                    {branches.map((b) => (
                      <li key={b}>
                        <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-bg">
                          <input
                            type="radio"
                            name={`branch-${sourceId}`}
                            checked={selected === b}
                            onChange={() => setSelected(b)}
                            className="h-3.5 w-3.5 accent-[var(--accent)]"
                          />
                          <span className="truncate font-mono text-xs text-fg">{b}</span>
                          {b === currentBranch ? (
                            <span className="ml-auto text-[10px] uppercase tracking-wider text-muted">
                              current
                            </span>
                          ) : null}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {branchError !== null && branches !== null && branches.length > 0 ? (
                <p className="px-3 pb-1 text-xs text-rose-400">{branchError}</p>
              ) : null}

              <div className="border-t border-border p-2">
                <button
                  type="button"
                  onClick={handleSaveBranch}
                  disabled={saving || selected === null || selected === currentBranch}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? <Spinner /> : null}
                  {saving ? 'Saving…' : 'Index this branch'}
                </button>
              </div>
            </div>
          )}
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

function branchErrorMessage(code: string): string {
  if (code === 'github_fetch_failed') return 'Could not reach GitHub. Try again.';
  if (code === 'not_a_github_repo') return 'This source has no GitHub repo.';
  if (code === 'source_not_found') return 'Source not found.';
  if (code === 'bad_branch') return 'Pick a branch first.';
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

function BackIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
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
