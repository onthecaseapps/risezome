'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Logo } from '../../_components/logo';
import { PanelToggleIcon } from './nav-icons';

const STORAGE_KEY = 'risezome.sidebar-collapsed';

/**
 * Client shell around the (server-rendered) sidebar content. Owns the
 * collapsed/expanded state — persisted to localStorage — and exposes it as a
 * `data-collapsed` attribute + `group/sb` so descendants (nav labels, the
 * workspace picker, the user card) hide via CSS without prop threading.
 *
 * The brand row + collapse toggle live here; the workspace picker, nav, and
 * footer are passed in as slots from the server component so data fetching
 * stays server-side.
 */
export function SidebarFrame({
  switcher,
  nav,
  footer,
}: {
  switcher: ReactNode;
  nav: ReactNode;
  footer: ReactNode;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  function toggle(): void {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* storage unavailable — collapse just won't persist */
      }
      return next;
    });
  }

  return (
    <aside
      data-collapsed={collapsed}
      className="group/sb flex h-dvh w-60 shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 data-[collapsed=true]:w-[68px]"
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-5 group-data-[collapsed=true]/sb:flex-col group-data-[collapsed=true]/sb:gap-3 group-data-[collapsed=true]/sb:px-2">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <Logo size={26} className="shrink-0 text-accent" />
          <span className="text-base font-semibold tracking-tight group-data-[collapsed=true]/sb:hidden">
            Risezome
          </span>
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-accent-soft/50 hover:text-fg"
        >
          <PanelToggleIcon />
        </button>
      </div>

      {switcher !== null && (
        <div className="px-4 pb-3 group-data-[collapsed=true]/sb:hidden">{switcher}</div>
      )}

      <nav className="flex-1 space-y-0.5 px-3 py-2 group-data-[collapsed=true]/sb:px-2">{nav}</nav>

      {footer}
    </aside>
  );
}
