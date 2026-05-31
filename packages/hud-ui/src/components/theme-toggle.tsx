'use client';

import { useEffect, useState, type ReactElement } from 'react';
import {
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemePreference,
} from '../lib/theme';

/**
 * Tri-state theme toggle. Cycles Light → Dark → System → Light → …
 * The glyph reflects the CURRENT PREFERENCE, not the rendered theme:
 *   - Sun     → 'light'
 *   - Moon    → 'dark'
 *   - Auto    → 'system' (split sun/moon glyph)
 *
 * In 'system' mode, an OS-level theme change (e.g., macOS auto-switch
 * at sunset) is picked up via matchMedia('(prefers-color-scheme: dark)')
 * and re-applied to the document automatically. The listener is only
 * installed when the preference is 'system' — manual modes ignore OS
 * changes.
 *
 * Initial preference is read on mount from localStorage so SSR and the
 * pre-React init script (which set the .dark class before hydration)
 * stay consistent. The toggle never re-renders before mount, so SSR
 * always shows the same "system" placeholder — small but acceptable
 * cost for not having a hydration mismatch.
 */
export function ThemeToggle(): ReactElement {
  const [pref, setPref] = useState<ThemePreference>('system');
  const [mounted, setMounted] = useState(false);

  // Sync from storage on mount + listen for OS theme changes when in
  // 'system' mode.
  useEffect(() => {
    setMounted(true);
    setPref(readStoredTheme());
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (pref !== 'system' || typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => applyTheme('system');
    // The legacy `addListener` survives in Safari < 14; modern browsers
    // use `addEventListener`. We try the modern API first.
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
    pref === 'light' ? 'Light theme (click for dark)'
    : pref === 'dark' ? 'Dark theme (click for system)'
    : 'System theme (click for light)';

  return (
    <button
      type="button"
      id="theme-toggle"
      className="icon-btn theme-toggle"
      aria-label={label}
      title={label}
      onClick={cycle}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {pref === 'light' ? <SunGlyph /> : pref === 'dark' ? <MoonGlyph /> : <AutoGlyph />}
      </span>
    </button>
  );
}

function SunGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.2 3.2l1.06 1.06M11.74 11.74l1.06 1.06M3.2 12.8l1.06-1.06M11.74 4.26l1.06-1.06" />
    </svg>
  );
}

function MoonGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
  );
}

/**
 * Split sun/moon glyph for the "follow system" state. The left half is
 * a sun (rays), the right half is a moon (crescent), to read as "auto
 * — could be either depending on OS".
 */
function AutoGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12" />
      <path d="M8 4a4 4 0 0 0 0 8" fill="currentColor" stroke="none" />
    </svg>
  );
}
