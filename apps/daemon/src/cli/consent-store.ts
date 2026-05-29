// Runtime consent check used by code that's about to make an outbound
// provider call (synthesizer, future LLM consumers). Reads the same
// `consent` table that `pnpm daemon consent grant <provider>` writes to.
//
// The helper takes an externally-owned `db` handle and must NOT use the
// `withDb` wrapper in apps/daemon/src/cli/consent.ts — that wrapper opens
// and closes its own connection, which would be catastrophic against the
// long-lived `serve.ts` connection used through the meeting.
//
// Revocation in the existing CLI is a plain `DELETE`, no tombstone — so
// "row present" means consent granted, "row absent" means denied.

import type { Database as DatabaseType } from 'better-sqlite3';
import type { ConsentProvider } from './consent.js';

export function hasConsent(db: DatabaseType, provider: ConsentProvider): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM consent WHERE provider_id = ? LIMIT 1')
    .get(provider) as { present?: number } | undefined;
  return row !== undefined && row.present === 1;
}
