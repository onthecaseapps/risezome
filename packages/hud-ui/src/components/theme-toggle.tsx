'use client';

import { useState, type ReactElement } from 'react';
import { THEME_STORAGE_KEY } from '../lib/theme';

/**
 * Header theme toggle. The initial state is read synchronously from the
 * .dark class that the layout's inline script already applied — so the
 * button's pressed state matches the rendered theme without a flash.
 *
 * Click flips the class on <html> and persists the new value. localStorage
 * writes are wrapped in try/catch so Safari private mode + quota-exceeded
 * don't crash the UI.
 */
export function ThemeToggle(): ReactElement {
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });

  function onClick(): void {
    const next = !isDark;
    document.documentElement.classList.toggle('dark', next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      // tolerate write failures (private mode, quota)
    }
    setIsDark(next);
  }

  return (
    <button
      type="button"
      id="theme-toggle"
      className="icon-btn theme-toggle"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      onClick={onClick}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {isDark ? <MoonGlyph /> : <SunGlyph />}
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
