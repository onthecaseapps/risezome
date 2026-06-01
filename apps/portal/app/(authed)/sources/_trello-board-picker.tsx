'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { selectTrelloBoardsAction } from './trello-select-action';

interface Board {
  id: string;
  name: string;
}

/**
 * Lets a connected org pick which Trello boards to index. Only boards not
 * already indexed are offered.
 *
 * Two modes:
 *   - First-time setup (`startCollapsed=false`): the checkbox picker shows
 *     inline so the user can pick their first boards.
 *   - After boards are indexed (`startCollapsed=true`): the picker is hidden
 *     behind a kebab (⋮) "Manage boards" menu, so the Sources page shows the
 *     indexed boards as rows rather than a perpetual selector. The user can
 *     re-open it any time to add more boards.
 *
 * Submitting upserts a source per board and kicks off indexing (server
 * action), then the page revalidates to show their status.
 */
export function TrelloBoardPicker({
  boards,
  startCollapsed = false,
}: {
  boards: Board[];
  startCollapsed?: boolean;
}): ReactElement | null {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!startCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);

  // Nothing left to add. After setup, render nothing; on first run, say so.
  if (boards.length === 0) {
    if (startCollapsed) return null;
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted">
        Every board on this Trello account is already indexed.
      </p>
    );
  }

  // Collapsed: a kebab menu whose one item reveals the picker.
  if (!expanded) {
    return (
      <div className="flex justify-end">
        <div className="relative">
          <button
            type="button"
            aria-label="Manage indexed boards"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-md p-1.5 text-muted hover:bg-bg"
          >
            <KebabIcon />
          </button>
          {menuOpen ? (
            <>
              {/* Transparent overlay catches outside clicks to close the menu. */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExpanded(true);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg"
                >
                  <GearIcon />
                  Manage boards
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
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
        {startCollapsed ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs text-muted hover:text-fg"
          >
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

function KebabIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
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
