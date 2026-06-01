import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ThemeToggle } from '../src/components/theme-toggle.js';
import {
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  resolveEffectiveTheme,
  writeStoredTheme,
} from '../src/lib/theme.js';

/**
 * The toggle is tri-state — Light → Dark → System → Light. The stored
 * value drives the rendered theme; 'system' resolves via matchMedia.
 * Tests cover both the init script (runs pre-React) and the runtime
 * button + helpers.
 */

function stubMatchMedia(prefersDark: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    return {
      matches: prefersDark && query.includes('dark'),
      media: query,
      onchange: null,
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      addListener: (): void => {},
      removeListener: (): void => {},
      dispatchEvent: (): boolean => true,
    };
  });
  return (): void => {
    window.matchMedia = original;
  };
}

describe('THEME_INIT_SCRIPT', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('is a non-empty static string', () => {
    expect(typeof THEME_INIT_SCRIPT).toBe('string');
    expect(THEME_INIT_SCRIPT.length).toBeGreaterThan(0);
  });

  it('applies .dark when localStorage has "dark"', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
     
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('omits .dark when localStorage has "light"', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
     
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('honors OS prefers-color-scheme when localStorage has "system"', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const restore = stubMatchMedia(true);
    try {
       
      new Function(THEME_INIT_SCRIPT)();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      restore();
    }
  });

  it('defaults to OS preference when no preference is stored', () => {
    const restore = stubMatchMedia(true);
    try {
       
      new Function(THEME_INIT_SCRIPT)();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      restore();
    }
  });

  it('does not throw when localStorage access fails', () => {
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = (): string | null => {
      throw new Error('Storage disabled');
    };
    try {
       
      expect(() => new Function(THEME_INIT_SCRIPT)()).not.toThrow();
    } finally {
      Storage.prototype.getItem = originalGet;
    }
  });
});

describe('theme helpers', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('readStoredTheme returns "system" when nothing is stored', () => {
    expect(readStoredTheme()).toBe('system');
  });

  it('readStoredTheme returns the stored value when valid', () => {
    writeStoredTheme('dark');
    expect(readStoredTheme()).toBe('dark');
    writeStoredTheme('light');
    expect(readStoredTheme()).toBe('light');
    writeStoredTheme('system');
    expect(readStoredTheme()).toBe('system');
  });

  it('resolveEffectiveTheme maps light/dark directly and resolves system via matchMedia', () => {
    expect(resolveEffectiveTheme('light')).toBe('light');
    expect(resolveEffectiveTheme('dark')).toBe('dark');
    const restoreDark = stubMatchMedia(true);
    try {
      expect(resolveEffectiveTheme('system')).toBe('dark');
    } finally {
      restoreDark();
    }
    const restoreLight = stubMatchMedia(false);
    try {
      expect(resolveEffectiveTheme('system')).toBe('light');
    } finally {
      restoreLight();
    }
  });

  it('applyTheme toggles the .dark class to match the resolved theme', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    const restore = stubMatchMedia(true);
    try {
      applyTheme('system');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('ThemeToggle', () => {
  let restoreMatchMedia: (() => void) | null = null;

  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    // Default to OS = light so 'system' resolves predictably.
    restoreMatchMedia = stubMatchMedia(false);
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    if (restoreMatchMedia !== null) {
      restoreMatchMedia();
      restoreMatchMedia = null;
    }
  });

  it('cycles preference Light → Dark → System → Light', () => {
    writeStoredTheme('light');
    const { getByRole } = render(<ThemeToggle />);
    const btn = getByRole('button');
    // After mount, pref reads as 'light'; click → 'dark'.
    fireEvent.click(btn);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // Click → 'system' (matchMedia stub says OS = light, so .dark off).
    fireEvent.click(btn);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    // Click → 'light'.
    fireEvent.click(btn);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('defaults to system preference when nothing is stored', () => {
    const { getByRole } = render(<ThemeToggle />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-label')).toMatch(/system/i);
  });

  it('does not crash when localStorage.setItem throws', () => {
    writeStoredTheme('light');
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = (): void => {
      throw new Error('quota');
    };
    try {
      const { getByRole } = render(<ThemeToggle />);
      expect(() => fireEvent.click(getByRole('button'))).not.toThrow();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      Storage.prototype.setItem = originalSet;
    }
  });

  it('reads initial preference from localStorage, not the .dark class', () => {
    writeStoredTheme('dark');
    // Leave DOM in light state — button should still reflect 'dark' pref.
    document.documentElement.classList.remove('dark');
    const { getByRole } = render(<ThemeToggle />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-label')).toMatch(/dark/i);
  });

  it('updates the label as the preference cycles', () => {
    writeStoredTheme('light');
    const { getByRole } = render(<ThemeToggle />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-label')).toMatch(/light/i);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-label')).toMatch(/dark/i);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-label')).toMatch(/system/i);
  });
});
