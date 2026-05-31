'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Drops a polling hook into the page that calls `router.refresh()` on an
 * interval whenever the parent says "things are still moving" via
 * `shouldPoll`. The server re-renders, RSC re-fetches the sources rows,
 * and the page reflects the latest indexer state without a hard reload.
 *
 * The interval intentionally lives in the client (not as a Suspense
 * boundary with revalidation) because the surface is small and the
 * progress is best displayed in-place rather than via streamed deltas.
 *
 * `intervalMs` defaults to 5 s — short enough that "Indexed 1 m ago"
 * feels alive, long enough that an idle org doesn't flood the server.
 * The effect is a no-op when `shouldPoll` is false, so an org with no
 * in-flight indexing burns zero requests.
 */
export function SourcesAutoRefresh({
  shouldPoll,
  intervalMs = 5_000,
}: {
  shouldPoll: boolean;
  intervalMs?: number;
}): null {
  const router = useRouter();
  useEffect(() => {
    if (!shouldPoll) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, shouldPoll, intervalMs]);
  return null;
}
