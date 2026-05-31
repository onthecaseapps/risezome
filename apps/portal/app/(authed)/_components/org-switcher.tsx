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
      <summary className="flex cursor-pointer list-none items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-accent-soft/50 hover:text-fg">
        <span className="truncate font-medium">{currentOrgName}</span>
        <span aria-hidden="true" className="text-[10px] opacity-60">▼</span>
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
