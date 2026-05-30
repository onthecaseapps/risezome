import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ThemeToggle } from '../app/components/theme-toggle';
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '../app/lib/theme';

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
    // eslint-disable-next-line no-new-func
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('omits .dark when localStorage has "light"', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    // eslint-disable-next-line no-new-func
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('does not throw when localStorage access fails', () => {
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = (): string | null => {
      throw new Error('Storage disabled');
    };
    try {
      // eslint-disable-next-line no-new-func
      expect(() => new Function(THEME_INIT_SCRIPT)()).not.toThrow();
    } finally {
      Storage.prototype.getItem = originalGet;
    }
  });
});

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('toggles the .dark class on <html> when clicked', () => {
    const { getByRole } = render(<ThemeToggle />);
    const btn = getByRole('button');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists the toggled value to localStorage', () => {
    const { getByRole } = render(<ThemeToggle />);
    fireEvent.click(getByRole('button'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    fireEvent.click(getByRole('button'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('does not crash when localStorage.setItem throws', () => {
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

  it('reads the initial pressed state from the existing .dark class', () => {
    document.documentElement.classList.add('dark');
    const { getByRole } = render(<ThemeToggle />);
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});
