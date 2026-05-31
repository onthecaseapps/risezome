'use client';

import { useState, type ReactElement } from 'react';
import { switchOrg } from './switch-org-action';

/**
 * Dropdown showing the current org with options to switch to another org or
 * create a new one. Lives in the topbar of the authed layout.
 *
 * Renders as a `<details>` element for zero-dependency disclosure behavior;
 * accessible by default (keyboard-friendly, escape-to-close on focus loss).
 * Switching is a server action that sets the cookie + redirects to /sources
 * so the next page render picks up the new org.
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
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm font-medium hover:border-[var(--accent)]">
        <span>{currentOrgName}</span>
        <span aria-hidden="true" className="text-xs opacity-60">▼</span>
      </summary>
      <div
        role="menu"
        className="absolute right-0 z-10 mt-1 min-w-[14rem] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card-bg)] shadow-md"
      >
        <ul className="max-h-80 overflow-y-auto py-1">
          {orgs.map((org) => (
            <li key={org.id}>
              <form action={switchOrg}>
                <input type="hidden" name="orgId" value={org.id} />
                <button
                  type="submit"
                  role="menuitemradio"
                  aria-checked={org.id === currentOrgId}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--accent)]/10"
                >
                  <span>{org.name}</span>
                  {org.id === currentOrgId && (
                    <span aria-hidden="true" className="text-xs">✓</span>
                  )}
                </button>
              </form>
            </li>
          ))}
        </ul>
        <div className="border-t border-[var(--border)]">
          <a
            href="/orgs/new"
            role="menuitem"
            className="block px-3 py-2 text-sm text-[var(--accent)] hover:bg-[var(--accent)]/10"
          >
            + Create new org
          </a>
        </div>
      </div>
    </details>
  );
}
