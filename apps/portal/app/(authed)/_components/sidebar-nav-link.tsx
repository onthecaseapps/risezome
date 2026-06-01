'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

/**
 * Sidebar nav item. Active state derived from the current pathname — the
 * link "owns" a route prefix so deep pages stay highlighted on their
 * parent nav (e.g., /meetings/upcoming → "Upcoming" active, /meetings/abc/live
 * → "Live meeting" active).
 *
 * `dot` slot renders to the right of the label — used for the red
 * "recording" indicator on "Live meeting" when a meeting is active.
 *
 * Disabled links render as inert spans with reduced opacity. We use this
 * for nav items whose pages haven't shipped yet (Upcoming, Live meeting,
 * Captures pre-U7/U11/U12) so the sidebar shape is complete without
 * dead links.
 */
export function SidebarNavLink({
  href,
  matchPrefix,
  icon,
  label,
  dot,
  disabled = false,
}: {
  href: string;
  /** URL prefix that should activate this link. e.g. "/sources" matches
   *  /sources/anything. RegExp is intentionally NOT supported here — props
   *  crossing the Server→Client component boundary must be JSON-serializable;
   *  RegExp isn't. If a future link needs structural pattern matching
   *  (e.g., /meetings/[id]/live), build a small dedicated client-only link
   *  that owns its own active-state logic. */
  matchPrefix: string;
  icon: ReactNode;
  label: string;
  dot?: ReactNode;
  disabled?: boolean;
}): ReactElement {
  const pathname = usePathname();
  const isActive = !disabled && pathname.startsWith(matchPrefix);

  const baseClasses =
    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors group-data-[collapsed=true]/sb:justify-center group-data-[collapsed=true]/sb:px-2';
  const stateClasses = disabled
    ? 'cursor-not-allowed text-muted opacity-50'
    : isActive
      ? 'bg-accent-soft text-accent'
      : 'text-fg/80 hover:bg-accent-soft/50 hover:text-fg';

  const inner = (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1 group-data-[collapsed=true]/sb:hidden">{label}</span>
      <span className="group-data-[collapsed=true]/sb:hidden">{dot}</span>
    </>
  );

  if (disabled) {
    return (
      <span className={`${baseClasses} ${stateClasses}`} aria-disabled="true" title={label}>
        {inner}
      </span>
    );
  }

  return (
    <Link href={href} className={`${baseClasses} ${stateClasses}`} title={label}>
      {inner}
    </Link>
  );
}
