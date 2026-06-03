import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time bearer-secret check for internal control endpoints (U12 / S13).
 *
 * `POST /meetings/:id/end` mutates in-memory state and is reachable over the
 * public dev tunnel, so it must not be anonymous. Callers (the portal webhook,
 * the manual end action, the stale-meeting reaper) send
 * `Authorization: Bearer <BOT_WORKER_SECRET>`.
 *
 * Both sides are SHA-256 hashed before comparison: this gives fixed-length
 * inputs to `timingSafeEqual` (which throws on length mismatch) and leaks no
 * length information. Uses Node's OpenSSL-backed `crypto` only — no hand-rolled
 * comparison (KTD1).
 */
export function bearerMatches(authHeader: string | undefined, secret: string): boolean {
  if (authHeader === undefined || secret.length === 0) return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length);
  return timingSafeEqual(sha256(provided), sha256(secret));
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}
