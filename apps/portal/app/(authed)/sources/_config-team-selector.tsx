'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactElement } from 'react';
import { useMenuBehaviors } from '../_components/overlay';
import { switchTeam } from '../_components/switch-team-action';

/**
 * "Configuring {team}" selector for the Sources page (KTD1). Unified with the
 * app-wide team lens: picking a team writes the global team-lens cookie (via
 * switchTeam) so the top-bar switcher and this pill stay in sync, then drops any
 * stale `?team=` override and refreshes — the page reads the cookie and
 * re-scopes every connection card's checked state to the new team.
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
  const [pending, startTransition] = useTransition();
  useMenuBehaviors(open, () => setOpen(false));
  const selected = teams.find((t) => t.id === selectedTeamId) ?? teams[0] ?? null;

  function choose(id: string): void {
    setOpen(false);
    if (id === selectedTeamId) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set('teamId', id);
      await switchTeam(fd); // set the global team-lens cookie (top-bar follows)
      router.replace('/sources'); // drop any ?team= override → cookie drives
      router.refresh(); // re-render so the page reads the new cookie
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 disabled:opacity-50"
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
            className="absolute right-0 top-11 z-20 max-h-72 w-56 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-[var(--shadow-pop)]"
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
