/**
 * Sanitize an index-failure message before it's stored in `sources.status_message`
 * (shown in the Sources UI). Two concerns:
 *   1. Don't leak another tenant's identifiers. The cross-org id-collision guard
 *      (forbid_org_move trigger) raises a message naming BOTH orgs' UUIDs; that
 *      message must never surface verbatim in the OTHER org's UI.
 *   2. Keep it short and human.
 * Unknown errors are UUID-redacted and truncated; the known collision case maps
 * to a friendly, identifier-free note.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function sanitizeStatusMessage(raw: string): string {
  if (/cross-org id collision/i.test(raw)) {
    return 'This source shares an identifier with another workspace and could not be indexed. Contact support.';
  }
  return raw.replace(UUID_RE, '<id>').slice(0, 500);
}
