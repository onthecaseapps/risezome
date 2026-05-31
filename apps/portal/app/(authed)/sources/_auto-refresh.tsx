'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Two side-effects in one component (both client-only):
 *
 * 1. **Polling.** When `shouldPoll` is true, call `router.refresh()` on an
 *    interval so the server component re-fetches sources rows in place.
 *    Idle orgs (`shouldPoll = false`) burn zero requests.
 *
 * 2. **One-shot banner cleanup.** When the URL carries banner query params
 *    (`?installed=true`, `?notice=...`, `?error=...`), strip them on mount
 *    via `window.history.replaceState` — no navigation, no re-fetch, just a
 *    silent URL update. Without this, the polled re-render keeps seeing the
 *    same query string and re-shows the banner every 5 s, making
 *    "GitHub connected" look stuck. Stripping in history (not via
 *    `router.replace`) avoids triggering an extra round-trip on mount.
 *
 * `intervalMs` defaults to 5 s — short enough that "Indexed 1 m ago" feels
 * alive, long enough not to flood the server.
 */
export function SourcesAutoRefresh({
  shouldPoll,
  intervalMs = 5_000,
}: {
  shouldPoll: boolean;
  intervalMs?: number;
}): null {
  const router = useRouter();

  // (2) Strip banner params from the URL on first mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const hadBannerParam =
      url.searchParams.has('installed') ||
      url.searchParams.has('notice') ||
      url.searchParams.has('error');
    if (!hadBannerParam) return;
    url.searchParams.delete('installed');
    url.searchParams.delete('notice');
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url.pathname + (url.search || ''));
  }, []);

  // (1) Polling.
  useEffect(() => {
    if (!shouldPoll) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, shouldPoll, intervalMs]);

  return null;
}
