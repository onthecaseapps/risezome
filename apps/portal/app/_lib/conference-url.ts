/**
 * Normalize a meeting join URL into a stable dedup key (plan KTD8).
 *
 * Two attendees of the same call may carry slightly different URLs — volatile
 * query params (Zoom `?pwd=`, calendar tracking params), a trailing slash,
 * host casing. Collapsing to `protocol//host/path` makes them match so the
 * launch path resolves them to ONE meeting (one bot, many participants).
 *
 * This intentionally does NOT try to distinguish two distinct meetings that
 * reuse the same recurring/personal-room link — that is handled by the
 * live-status dedup index (a completed meeting does not block the next one),
 * not by the key. Pure function: no I/O.
 */
export function normalizeConferenceUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, ''); // drop trailing slash(es)
    return `${u.protocol}//${host}${path}`;
  } catch {
    // Not a parseable absolute URL — fall back to a trimmed, lowercased form
    // so two identical hand-pasted strings still dedup.
    return trimmed.toLowerCase();
  }
}
