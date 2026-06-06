'use client';

import { useState, type ReactElement } from 'react';
import { usePathname } from 'next/navigation';
import { switchTeam } from './switch-team-action';

export interface TeamOption {
  id: string;
  name: string;
  slug: string;
}

/**
 * Top-bar breadcrumb: "OrgName / {team} / {page}".
 *   - OrgName  — static (the workspace brand).
 *   - team     — the team-lens segment. With ≥1 team it's a clickable dropdown
 *                (the user's teams + a "My meetings" entry that clears the lens) —
 *                even a single team is worth a switcher, since the lens toggles
 *                between that team and "My meetings". Only a team-less user gets
 *                static text. Selecting a team calls the
 *                {@link switchTeam} server action (sets the team cookie) and
 *                refreshes via the action's revalidate. Shows "All meetings" when
 *                no team lens is selected.
 *   - page     — the current page, derived from the pathname. Omitted on routes
 *                with no mapped label (a safe fallback → just "Org / team").
 *
 * Clicking the TEAM segment (not the org) opens the switcher.
 */
export function TeamSwitcher({
  orgName,
  currentTeamId,
  teams,
}: {
  orgName: string;
  /** The currently selected team, or null for the "My meetings" lens. */
  currentTeamId: string | null;
  teams: TeamOption[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const pageLabel = pageLabelFromPath(pathname);
  const current = teams.find((t) => t.id === currentTeamId) ?? null;
  const teamCrumb = current !== null ? `#${current.slug}` : 'All meetings';
  // Show the switcher whenever there's at least one team: the lens toggles
  // between "My meetings" and the team(s), so even one team is switchable.
  const hasSwitcher = teams.length >= 1;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="truncate font-medium text-fg">{orgName}</span>
      <Sep />

      {hasSwitcher ? (
        <details
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
          className="relative min-w-0"
        >
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted transition-colors hover:bg-accent-soft/50 hover:text-fg">
            <span className="truncate">{teamCrumb}</span>
            <ChevronDown />
          </summary>
          <div
            role="menu"
            className="absolute left-0 z-20 mt-1 min-w-[220px] overflow-hidden rounded-md border border-border bg-card shadow-lg"
          >
            <ul className="max-h-72 overflow-y-auto py-1">
              <li>
                <form action={switchTeam}>
                  <input type="hidden" name="teamId" value="all" />
                  <button
                    type="submit"
                    role="menuitemradio"
                    aria-checked={currentTeamId === null}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent-soft/50"
                  >
                    <span className="truncate">My meetings</span>
                    {currentTeamId === null && (
                      <span aria-hidden="true" className="text-xs text-accent">
                        ✓
                      </span>
                    )}
                  </button>
                </form>
              </li>
              <li className="my-1 border-t border-border" aria-hidden="true" />
              {teams.map((team) => (
                <li key={team.id}>
                  <form action={switchTeam}>
                    <input type="hidden" name="teamId" value={team.id} />
                    <button
                      type="submit"
                      role="menuitemradio"
                      aria-checked={team.id === currentTeamId}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent-soft/50"
                    >
                      <span className="truncate">
                        <span className="text-muted">#</span>
                        {team.slug}
                      </span>
                      {team.id === currentTeamId && (
                        <span aria-hidden="true" className="text-xs text-accent">
                          ✓
                        </span>
                      )}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : (
        <span className="truncate text-muted">{teamCrumb}</span>
      )}

      {pageLabel !== null && (
        <>
          <Sep />
          <span aria-current="page" className="truncate text-fg">
            {pageLabel}
          </span>
        </>
      )}
    </nav>
  );
}

/**
 * Map the active pathname to a page label for the breadcrumb's last segment.
 * Ordered most-specific-first; returns null for unmapped routes (segment hidden).
 */
function pageLabelFromPath(pathname: string): string | null {
  const routes: [prefix: string, label: string][] = [
    ['/upcoming', 'Upcoming'],
    ['/meetings/live', 'Live meeting'],
    ['/meetings', 'Meeting'],
    ['/captures', 'Captures'],
    ['/gaps', 'Knowledge gaps'],
    ['/sources', 'Sources'],
    ['/teams', 'Teams & members'],
    ['/members', 'Teams & members'],
    ['/settings', 'Settings'],
    ['/whats-new', "What's new"],
    ['/debug/live-mic', 'Live-mic debug'],
    ['/debug/ask', 'Retrieval probe'],
    ['/debug/eval', 'Corpus eval'],
  ];
  for (const [prefix, label] of routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return label;
  }
  return null;
}

function Sep(): ReactElement {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted">
      /
    </span>
  );
}

function ChevronDown(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 opacity-60"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
