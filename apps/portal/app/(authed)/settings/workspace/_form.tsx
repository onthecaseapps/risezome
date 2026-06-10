'use client';

import { useEffect, useState, useTransition, type ReactElement } from 'react';
import { updateWorkspaceNameAction } from './save-action';

const ERROR_LABEL: Record<string, string> = {
  empty_name: 'Workspace name can’t be empty.',
  name_too_long: 'Workspace name must be 100 characters or fewer.',
};

/**
 * Edit the workspace (org) name. Admin-only — the page is requireManager-gated
 * and the action re-checks. Save is disabled until the name actually changes;
 * a successful save updates the top-bar brand (the action revalidates the
 * authed layout).
 */
export function WorkspaceNameForm({ initialName }: { initialName: string }): ReactElement {
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // If the server re-renders with a new name (after save), re-sync the baseline.
  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  const trimmed = name.trim();
  const dirty = trimmed !== initialName && trimmed.length > 0;

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!dirty || pending) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateWorkspaceNameAction(name);
      if (result.ok) {
        setSaved(true);
      } else {
        setError(ERROR_LABEL[result.error] ?? 'Couldn’t save. Please try again.');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-border bg-card p-5 shadow-[var(--card-shadow)]">
      <label htmlFor="workspace-name" className="block text-sm font-medium text-fg">
        Workspace name
      </label>
      <p className="mt-1 text-sm text-muted">
        Shown in the top bar and on invites. Visible to everyone in the workspace.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          id="workspace-name"
          type="text"
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
            setError(null);
          }}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          placeholder="e.g. Acme Engineering"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={!dirty || pending}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error !== null && <p className="mt-2 text-sm text-error">{error}</p>}
      {saved && error === null && <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>}
    </form>
  );
}
