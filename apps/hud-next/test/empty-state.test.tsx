import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { EMPTY_STATE_MESSAGES, EmptyState } from '../app/components/empty-state';

describe('EmptyState', () => {
  it('renders a placeholder message from EMPTY_STATE_MESSAGES', () => {
    const { container } = render(<EmptyState />);
    const text = container.textContent ?? '';
    expect(EMPTY_STATE_MESSAGES.some((m) => text.includes(m))).toBe(true);
  });

  it('rotates the message every 10s', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<EmptyState />);
      const first = container.querySelector('.empty-state-msg')?.textContent;
      vi.advanceTimersByTime(10_000);
      const second = container.querySelector('.empty-state-msg')?.textContent;
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(EMPTY_STATE_MESSAGES.includes(second!)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer on unmount', () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(window, 'clearInterval');
      const { unmount } = render(<EmptyState />);
      unmount();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EMPTY_STATE_MESSAGES', () => {
  it('preserves the oceanographic copy verbatim from the production HUD', () => {
    // Smoke-check a known line so a future refactor that accidentally
    // drops or replaces messages is caught.
    expect(EMPTY_STATE_MESSAGES).toContain('Waiting for some swell information to surface.');
    expect(EMPTY_STATE_MESSAGES).toContain('Hush mode engaged. The HUD listens.');
    expect(EMPTY_STATE_MESSAGES.length).toBeGreaterThanOrEqual(14);
  });
});
