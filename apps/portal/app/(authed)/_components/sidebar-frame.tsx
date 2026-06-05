'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { PanelToggleIcon } from './nav-icons';

/**
 * Left nav rail. Holds the nav icons — the brand, team switcher, and user menu
 * live in the top bar (U6). Collapsible: a bottom toggle expands the rail to show
 * labels or collapses it to the narrow icon form. The choice persists in
 * localStorage. The rail keeps the `group/sb` + `data-collapsed` marker that
 * {@link SidebarNavLink} (and the dev-section heading) key off, so every link
 * shows/hides its label off that one attribute without prop threading.
 *
 * Defaults to collapsed (and renders collapsed on the server) so the first paint
 * matches the icon rail; the persisted preference is applied after hydration.
 */
const STORAGE_KEY = 'rz.sidebar.collapsed';

export function SidebarFrame({ nav }: { nav: ReactNode }): ReactElement {
  const [collapsed, setCollapsed] = useState(true);

  // Apply the persisted preference after hydration. Initial state (collapsed)
  // matches the server render, so there's no hydration mismatch — only a one-off
  // flip to expanded for users who previously expanded it.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) setCollapsed(stored === 'true');
  }, []);

  const toggle = (): void => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Private mode / storage disabled — toggle still works for the session.
      }
      return next;
    });
  };

  return (
    <aside
      data-collapsed={collapsed ? 'true' : 'false'}
      className={`group/sb flex h-full shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 ${collapsed ? 'w-[64px]' : 'w-[232px]'}`}
    >
      <nav className="flex-1 space-y-0.5 px-2 py-3">{nav}</nav>
      <div className="border-t border-border px-2 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-fg/80 transition-colors hover:bg-accent-soft/50 hover:text-fg group-data-[collapsed=true]/sb:justify-center group-data-[collapsed=true]/sb:px-2"
        >
          <span className={collapsed ? '' : 'rotate-180 transition-transform'}>
            <PanelToggleIcon />
          </span>
          <span className="flex-1 text-left group-data-[collapsed=true]/sb:hidden">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
