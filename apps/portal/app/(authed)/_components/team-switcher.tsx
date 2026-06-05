'use client';

import { useState, type ReactElement } from 'react';
import { switchTeam } from './switch-team-action';

export interface TeamOption {
  id: string;
  name: string;
  slug: string;
}

/**
 * Top-bar breadcrumb + team-lens switcher: "OrgName / #team-slug" (or
 * "OrgName / All meetings" when no team is selected). Clicking opens a menu of
 * the user's teams plus a "My meetings" entry that clears the lens. Selecting an
 * entry calls the {@link switchTeam} server action (sets the team cookie) and
 * refreshes via the action's revalidate.
 *
 * With 0 or 1 teams there is nothing to switch between, so we render the
 * breadcrumb as plain text with no interactive dropdown. Uses the same
 * native-`<details>` disclosure + styling the org switcher used.
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
  const current = teams.find((t) => t.id === currentTeamId) ?? null;
  const crumb = current !== null ? `#${current.slug}` : 'All meetings';

  // Nothing to switch between: render the breadcrumb as static text.
  if (teams.length <= 1) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate font-medium text-fg">{orgName}</span>
        <span aria-hidden="true" className="text-muted">
          /
        </span>
        <span className="truncate text-muted">{crumb}</span>
      </div>
    );
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="relative min-w-0"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent-soft/50">
        <span className="truncate font-medium text-fg">{orgName}</span>
        <span aria-hidden="true" className="text-muted">
          /
        </span>
        <span className="truncate text-muted">{crumb}</span>
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
