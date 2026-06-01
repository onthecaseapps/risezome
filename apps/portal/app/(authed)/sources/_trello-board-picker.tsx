'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { selectTrelloBoardsAction } from './trello-select-action';

interface Board {
  id: string;
  name: string;
}

/**
 * The Trello board checkbox picker. Only boards not already indexed are
 * offered. Submitting upserts a source per board and kicks off indexing, then
 * the page revalidates to show their status. Visibility is owned by the parent
 * (ConnectionSources): on first-time setup it renders inline; after boards are
 * indexed it's shown only when the user picks "Manage boards" from a row's ⋮
 * menu, in which case `onDone` renders a control to collapse it again.
 */
export function TrelloBoardPicker({
  boards,
  onDone,
}: {
  boards: Board[];
  onDone?: (() => void) | undefined;
}): ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (boards.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted">
        Every board on this Trello account is already indexed.
      </p>
    );
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit(): void {
    setError(null);
    const selection = boards.filter((b) => selected.has(b.id)).map((b) => ({ id: b.id, name: b.name }));
    if (selection.length === 0) return;
    const formData = new FormData();
    formData.set('selection', JSON.stringify(selection));
    startTransition(async () => {
      const res = await selectTrelloBoardsAction(formData);
      if (!res.ok) setError(res.error);
      else setSelected(new Set());
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Choose boards to index:</p>
        {onDone !== undefined ? (
          <button type="button" onClick={onDone} className="text-xs text-muted hover:text-fg">
            Done
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1.5">
        {boards.map((b) => (
          <li key={b.id}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent-soft">
              <input
                type="checkbox"
                checked={selected.has(b.id)}
                onChange={() => toggle(b.id)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="text-fg">{b.name}</span>
            </label>
          </li>
        ))}
      </ul>
      {error !== null ? <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      <button
        type="button"
        onClick={submit}
        disabled={pending || selected.size === 0}
        className="mt-3 inline-flex items-center rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Adding…' : `Index ${selected.size > 0 ? selected.size : ''} board${selected.size === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}
