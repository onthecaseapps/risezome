/**
 * Constrain an OAuth `next` redirect target to a same-origin relative path.
 *
 * The auth callback feeds `next` into `new URL(next, origin)`; an absolute or
 * protocol-relative value would redirect off-origin (open redirect / phishing).
 * Invite links make this reachable by any anonymous token holder, so every
 * `next` is sanitized to a leading-slash relative path before use.
 */
export function sanitizeNext(value: string | null, fallback = '/onboarding'): string {
  if (value === null || value.length === 0) return fallback;
  // Must be a relative path. Reject absolute URLs, protocol-relative (//host),
  // any scheme, and backslash tricks browsers may normalize to a host.
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.includes('://') || value.includes('\\')) return fallback;
  return value;
}
