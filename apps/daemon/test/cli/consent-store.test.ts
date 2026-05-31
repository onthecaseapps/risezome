import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openCorpusDb } from '../../src/corpus/db.js';
import { migrate } from '../../src/corpus/migrate.js';
import { hasConsent } from '../../src/cli/consent-store.js';

describe('hasConsent', () => {
  let db: DatabaseType;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'risezome-consent-'));
    db = await openCorpusDb({ path: join(dir, 'risezome.db') });
    await migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  function grant(provider: string): void {
    db.prepare(
      `INSERT INTO consent (provider_id, granted_at, granted_by, scope)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET granted_at = excluded.granted_at`,
    ).run(provider, Date.now(), 'test', 'all');
  }

  function revoke(provider: string): void {
    db.prepare('DELETE FROM consent WHERE provider_id = ?').run(provider);
  }

  it('returns true when a grant exists for the requested provider', () => {
    grant('anthropic');
    expect(hasConsent(db, 'anthropic')).toBe(true);
  });

  it('returns false when the consent table is empty', () => {
    expect(hasConsent(db, 'anthropic')).toBe(false);
  });

  it('returns false when only a different provider is granted', () => {
    grant('voyage');
    expect(hasConsent(db, 'anthropic')).toBe(false);
  });

  it('returns false after the grant has been revoked (plain DELETE)', () => {
    grant('anthropic');
    expect(hasConsent(db, 'anthropic')).toBe(true);
    revoke('anthropic');
    expect(hasConsent(db, 'anthropic')).toBe(false);
  });

  it('treats independent providers independently', () => {
    grant('anthropic');
    grant('voyage');
    expect(hasConsent(db, 'anthropic')).toBe(true);
    expect(hasConsent(db, 'voyage')).toBe(true);
    revoke('voyage');
    expect(hasConsent(db, 'anthropic')).toBe(true);
    expect(hasConsent(db, 'voyage')).toBe(false);
  });

  it('uses the externally-owned db handle without closing it', () => {
    grant('anthropic');
    hasConsent(db, 'anthropic');
    hasConsent(db, 'anthropic');
    // If hasConsent had wrapped the call in `withDb` and closed the connection,
    // the next statement would throw. Asserting the handle is still alive by
    // running another query.
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
  });
});
