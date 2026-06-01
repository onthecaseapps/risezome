'use client';

import { useState, type ReactElement } from 'react';
import { switchOrg } from './switch-org-action';

/**
 * Click-to-open org chip in the sidebar. Compact: shows current org name
 * with a small chevron; expands to a menu of all the user's orgs +
 * "Create new org" link.
 *
 * Implemented as a native `<details>` so we inherit a free zero-dependency
 * disclosure: keyboard-accessible, escape-closes (via native onToggle),
 * no JS-driven open/close state to manage.
 */
export function OrgSwitcher({
  currentOrgId,
  currentOrgName,
  orgs,
}: {
  currentOrgId: string;
  currentOrgName: string;
  orgs: Array<{ id: string; name: string; role: string }>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="relative"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-2 text-sm text-fg transition-colors hover:border-accent/60">
        <WorkspaceGlyph />
        <span className="flex-1 truncate font-medium">{currentOrgName}</span>
        <ChevronDown />
      </summary>
      <div
        role="menu"
        className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-lg"
      >
        <ul className="max-h-64 overflow-y-auto py-1">
          {orgs.map((org) => (
            <li key={org.id}>
              <form action={switchOrg}>
                <input type="hidden" name="orgId" value={org.id} />
                <button
                  type="submit"
                  role="menuitemradio"
                  aria-checked={org.id === currentOrgId}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent-soft/50"
                >
                  <span className="truncate">{org.name}</span>
                  {org.id === currentOrgId && (
                    <span aria-hidden="true" className="text-xs text-accent">✓</span>
                  )}
                </button>
              </form>
            </li>
          ))}
        </ul>
        <div className="border-t border-border">
          <a
            href="/orgs/new"
            role="menuitem"
            className="block px-3 py-2 text-sm text-accent hover:bg-accent-soft/50"
          >
            + Create new org
          </a>
        </div>
      </div>
    </details>
  );
}

function WorkspaceGlyph(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-accent"
    >
      <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
      <path d="m3 7 9 5 9-5M12 12v10" />
    </svg>
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
