import type { ReactElement, ReactNode } from 'react';

/**
 * Slim left nav rail. Holds only the nav icons now — the brand, team switcher,
 * and user menu moved to the top bar (U6). Icon-only by design: it keeps the
 * `group/sb` + `data-collapsed=true` marker that {@link SidebarNavLink} (and the
 * dev-section heading) already key off, so each link renders centered and
 * label-less without any prop threading or per-link changes.
 *
 * A plain server component now — there's no collapse toggle to own, so no client
 * state and no localStorage. The rail is always the narrow icon form.
 */
export function SidebarFrame({ nav }: { nav: ReactNode }): ReactElement {
  return (
    <aside
      data-collapsed="true"
      className="group/sb flex h-full w-[64px] shrink-0 flex-col border-r border-border bg-card"
    >
      <nav className="flex-1 space-y-0.5 px-2 py-3">{nav}</nav>
    </aside>
  );
}
