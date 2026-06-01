'use client';

import { useEffect, useState, useTransition, type ReactElement, type ReactNode } from 'react';
import { SourceActions } from './_source-actions';
import { listRepoBranchesAction, setRepoBranchAction } from './repo-settings-action';

/**
 * Client shell for a GitHub source row. The presentational content (icon,
 * name, branch, status, status badge) is server-rendered and passed in as
 * `children` + `rightSlot`; this component only owns the interactive bits — the
 * ⋮ menu and the "Manage repo settings" branch panel that drops in below the
 * row (matching the Trello/Atlassian "Manage …" pattern).
 */
export function GithubRepoItem({
  sourceId,
  currentBranch,
  busy,
  errored,
  rightSlot,
  children,
}: {
  sourceId: string;
  currentBranch: string | null;
  busy: boolean;
  errored: boolean;
  rightSlot: ReactNode;
  children: ReactNode;
}): ReactElement {
  const [managing, setManaging] = useState(false);

  return (
    <>
      <div
        className={`flex items-center gap-4 rounded-xl border bg-card p-4 ${
          errored ? 'border-rose-400/40' : 'border-border'
        }`}
      >
        {children}
        <div className="flex flex-shrink-0 items-center gap-2">
          {rightSlot}
          <SourceActions sourceId={sourceId} busy={busy} onManageSettings={() => setManaging(true)} />
        </div>
      </div>

      {managing ? (
        <div className="mt-2">
          <RepoBranchPanel
            sourceId={sourceId}
            currentBranch={currentBranch}
            onDone={() => setManaging(false)}
          />
        </div>
      ) : null}
    </>
  );
}

function RepoBranchPanel({
  sourceId,
  currentBranch,
  onDone,
}: {
  sourceId: string;
  currentBranch: string | null;
  onDone: () => void;
}): ReactElement {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(currentBranch);
  const [saving, startSave] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listRepoBranchesAction(sourceId);
      if (cancelled) return;
      if (!res.ok) {
        setError(branchErrorMessage(res.error));
        setBranches([]);
        return;
      }
      setBranches(res.branches);
      setSelected((prev) => prev ?? res.current);
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  function save(): void {
    if (selected === null || selected === currentBranch) return;
    setError(null);
    startSave(async () => {
      const res = await setRepoBranchAction(sourceId, selected);
      if (!res.ok) setError(branchErrorMessage(res.error));
      else onDone();
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Choose the branch to index:</p>
        <button type="button" onClick={onDone} className="text-xs text-muted hover:text-fg">
          Done
        </button>
      </div>

      {branches === null ? (
        <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted">
          <Spinner />
          Loading branches…
        </div>
      ) : branches.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted">{error ?? 'No branches found.'}</p>
      ) : (
        <ul className="max-h-56 flex flex-col gap-0.5 overflow-y-auto">
          {branches.map((b) => (
            <li key={b}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent-soft">
                <input
                  type="radio"
                  name={`branch-${sourceId}`}
                  checked={selected === b}
                  onChange={() => setSelected(b)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                <span className="truncate font-mono text-xs text-fg">{b}</span>
                {b === currentBranch ? (
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-muted">current</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      )}

      {error !== null && branches !== null && branches.length > 0 ? (
        <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={save}
        disabled={saving || selected === null || selected === currentBranch}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? <Spinner /> : null}
        {saving ? 'Saving…' : 'Index this branch'}
      </button>
    </div>
  );
}

function branchErrorMessage(code: string): string {
  if (code === 'github_fetch_failed') return 'Could not reach GitHub. Try again.';
  if (code === 'not_a_github_repo') return 'This source has no GitHub repo.';
  if (code === 'source_not_found') return 'Source not found.';
  if (code === 'bad_branch') return 'Pick a branch first.';
  return `Failed (${code})`;
}

function Spinner(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
