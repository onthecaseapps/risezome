'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';

/**
 * Settings left category nav (mockup #24). The mockup categories are Profile,
 * Workspace, Meeting bot, Members, Billing; Audit log is appended so the
 * existing audit page stays reachable. Profile/Workspace/Billing are stubs until
 * their pages are built. Members links to the existing top-level /members page.
 *
 * Client component: active state keys off the current pathname. A category is
 * active when the path equals its href or is nested under it.
 */
const ITEMS: { label: string; href: string }[] = [
  { label: 'Profile', href: '/settings/profile' },
  { label: 'Workspace', href: '/settings/workspace' },
  { label: 'Meeting bot', href: '/settings/meeting-bot' },
  { label: 'Members', href: '/members' },
  { label: 'Billing', href: '/settings/billing' },
  { label: 'Audit log', href: '/settings/audit' },
];

export function SettingsNav(): ReactElement {
  const pathname = usePathname();
  return (
    <nav className="w-[220px] shrink-0 space-y-0.5 border-r border-border p-4">
      {ITEMS.map((it) => {
        const active = pathname === it.href || pathname.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? 'page' : undefined}
            className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? 'bg-accent-soft text-accent'
                : 'text-muted hover:bg-accent-soft/50 hover:text-fg'
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
