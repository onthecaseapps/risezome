'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';

/**
 * "Configuring {team}" selector for the Sources page (KTD1). The page is a
 * per-team editor scoped by a `?team=<teamId>` search param — a deliberate admin
 * choice, distinct from the browse-lens cookie. Picking a team navigates to
 * `/sources?team=<id>`, which re-scopes every connection card's checked state.
 *
 * Mirrors the top-bar team-switcher dropdown styling (bordered pill + chevron,
 * outside-click overlay) so the surface stays visually consistent.
 */
export interface ConfigTeam {
  id: string;
  name: string;
}

export function ConfigTeamSelector({
  teams,
  selectedTeamId,
}: {
  teams: ConfigTeam[];
  selectedTeamId: string;
}): ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const selected = teams.find((t) => t.id === selectedTeamId) ?? teams[0] ?? null;

  function choose(id: string): void {
    setOpen(false);
    if (id !== selectedTeamId) {
      router.push(`/sources?team=${encodeURIComponent(id)}`);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40"
      >
        <span className="text-xs uppercase tracking-wider text-muted">Configuring</span>
        <span className="text-fg">{selected !== null ? selected.name : 'a team'}</span>
        <ChevronDown />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            className="absolute right-0 top-11 z-20 max-h-72 w-56 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg"
          >
            {teams.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={t.id === selectedTeamId}
                  onClick={() => choose(t.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    t.id === selectedTeamId
                      ? 'bg-accent-soft text-fg'
                      : 'text-fg hover:bg-bg'
                  }`}
                >
                  <span className="truncate">{t.name}</span>
                  {t.id === selectedTeamId ? <CheckGlyph /> : null}
                </button>
              </li>
            ))}
            {teams.length === 0 ? (
              <li className="px-3 py-2 text-center text-sm text-muted">No teams yet.</li>
            ) : null}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ChevronDown(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="flex-none text-accent" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
