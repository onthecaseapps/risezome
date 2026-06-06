/**
 * Captures-list recap preview resolution. The card summary prefers the
 * structured recap's `overview` (new meetings) and falls back to the legacy
 * markdown blob (old meetings). Resolving the overview server-side here keeps
 * the client's markdown firstLine() from ever running over a JSON string.
 */

/** Extract the overview from a decrypted structured-recap JSON string; null if unparseable/empty. */
export function structuredRecapOverview(decryptedJson: string): string | null {
  try {
    const parsed = JSON.parse(decryptedJson) as { overview?: unknown };
    const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
    return overview.length > 0 ? overview : null;
  } catch {
    return null;
  }
}
