/**
 * The canonical app origin for building OAuth redirect_uri / return URLs.
 *
 * Deriving these from the request Host header lets a spoofed Host produce an
 * authorize URL / redirect_uri pointing at an attacker origin. Providers reject
 * a redirect_uri that doesn't match the registered value (so this is mostly an
 * authorize-URL phishing / defense-in-depth concern, not a token leak), but the
 * OAuth surface should not trust the Host header. When APP_ORIGIN is configured
 * we pin to it; otherwise we fall back to the request origin (dev / preview).
 */
export function appOrigin(requestOrigin: string): string {
  const configured = (process.env.APP_ORIGIN ?? '').trim();
  if (configured.length === 0) return requestOrigin;
  try {
    return new URL(configured).origin;
  } catch {
    return requestOrigin;
  }
}
