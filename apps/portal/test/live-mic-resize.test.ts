import { describe, expect, it } from 'vitest';
import { clampWidth } from '../app/(authed)/debug/live-mic/_resize';

describe('clampWidth (live-mic resizable columns)', () => {
  it('clamps within [min, max]', () => {
    expect(clampWidth(100, 180, 560)).toBe(180);
    expect(clampWidth(300, 180, 560)).toBe(300);
    expect(clampWidth(900, 180, 560)).toBe(560);
  });

  it('falls back to min on a non-finite value (corrupt localStorage)', () => {
    expect(clampWidth(Number.NaN, 180, 560)).toBe(180);
    expect(clampWidth(Number.POSITIVE_INFINITY, 180, 560)).toBe(180);
  });
});
