'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemePreference,
} from '@risezome/hud-ui';

/**
 * Top-bar user-avatar dropdown. Avatar shows initials in a colored circle
 * (no Gravatar / Google avatar fetch yet — see UserCard's note). Clicking opens
 * a menu: identity header, Profile & account, Notification settings, a theme
 * cycle, and Sign out. No "switch workspace" item (single org).
 *
 * Built from UserCard's content (avatar initials, theme cycle, POST sign-out
 * form) but reshaped from the old sidebar footer into a dropdown for the top bar.
 * Native `<details>` gives free keyboard-accessible, escape-closes disclosure —
 * same idiom as TeamSwitcher.
 */
export function UserAvatarMenu({
  email,
  fullName,
}: {
  email: string;
  fullName?: string | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const display = fullName ?? email;
  const initials = initialsFor(display);

  // Native <details> only toggles via its <summary>; it stays open on an outside
  // click. Close it on a pointer-down outside the element or on Escape whenever
  // it's open, matching normal dropdown behaviour (same idiom as TeamSwitcher).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      if (detailsRef.current !== null && !detailsRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <details
      ref={detailsRef}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="relative"
    >
      <summary
        className="flex cursor-pointer list-none items-center rounded-full transition-opacity hover:opacity-90"
        aria-label="Account menu"
        title={display}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
          {initials}
        </span>
      </summary>
      <div
        role="menu"
        className="absolute right-0 z-20 mt-1 min-w-[240px] overflow-hidden rounded-md border border-border bg-card shadow-lg"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{fullName ?? email.split('@')[0]}</div>
            <div className="truncate text-xs text-muted">{email}</div>
          </div>
        </div>

        <ul className="py-1">
          <li>
            <a
              href="/settings"
              role="menuitem"
              className="block px-3 py-2 text-sm hover:bg-accent-soft/50"
            >
              Profile &amp; account
            </a>
          </li>
          <li>
            <a
              href="/settings"
              role="menuitem"
              className="block px-3 py-2 text-sm hover:bg-accent-soft/50"
            >
              Notification settings
            </a>
          </li>
        </ul>

        <div className="border-t border-border px-3 py-2">
          <ThemeCycleRow />
        </div>

        <div className="border-t border-border">
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-accent-soft/50 hover:text-fg"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </form>
        </div>
      </div>
    </details>
  );
}

/**
 * Theme cycle row (Light → Dark → System → Light). Mirrors UserCard's
 * ThemeCycleButton logic; reshaped as a labeled full-width row for the dropdown.
 * Glyph reflects the stored preference, not the rendered theme.
 */
function ThemeCycleRow(): ReactElement {
  const [pref, setPref] = useState<ThemePreference>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setPref(readStoredTheme());
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (pref !== 'system' || typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => applyTheme('system');
    try {
      mql.addEventListener('change', handler);
      return (): void => mql.removeEventListener('change', handler);
    } catch {
      mql.addListener(handler);
      return (): void => mql.removeListener(handler);
    }
  }, [pref, mounted]);

  function cycle(): void {
    const next: ThemePreference =
      pref === 'light' ? 'dark' : pref === 'dark' ? 'system' : 'light';
    setPref(next);
    writeStoredTheme(next);
    applyTheme(next);
  }

  const label =
    pref === 'light' ? 'Light' : pref === 'dark' ? 'Dark' : 'System';

  return (
    <button
      type="button"
      onClick={cycle}
      className="flex w-full items-center justify-between rounded-md px-1 py-1 text-sm text-fg/90 transition-colors hover:text-fg"
      title="Cycle theme"
    >
      <span className="text-muted">Theme</span>
      <span className="flex items-center gap-1.5">
        {pref === 'light' ? <SunIcon /> : pref === 'dark' ? <MoonIcon /> : <AutoIcon />}
        <span>{label}</span>
      </span>
    </button>
  );
}

function SunIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4 19 5" />
    </svg>
  );
}

function MoonIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

function AutoIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 6a6 6 0 0 1 0 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function initialsFor(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '?';
  const parts = trimmed.split(/[\s.@]+/).filter((s) => s.length > 0);
  if (parts.length === 0) return trimmed.charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}
