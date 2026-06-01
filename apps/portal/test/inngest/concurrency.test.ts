import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/inngest/lib/concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Later items resolve sooner, so a naive push-on-settle would reorder.
    const items = [0, 1, 2, 3, 4];
    const out = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, (items.length - n) * 5));
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit of in-flight tasks', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('propagates the first rejection (so a failed doc fails the batch)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('treats a limit below 1 as a single worker', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it('handles an empty input without spawning workers', async () => {
    const out = await mapWithConcurrency([], 4, async (n) => n);
    expect(out).toEqual([]);
  });
});
