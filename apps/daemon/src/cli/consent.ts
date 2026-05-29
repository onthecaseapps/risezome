import type { Database as DatabaseType } from 'better-sqlite3';
import { openCorpusDb } from '../corpus/db.js';
import { migrate } from '../corpus/migrate.js';
import { log } from './util.js';

const SUPPORTED_PROVIDERS = new Set(['deepgram', 'voyage', 'openai', 'anthropic']);

export async function runConsentCommand(args: readonly string[]): Promise<number> {
  const action = args[0];
  if (action === 'list') {
    return listConsent();
  }
  if (action === 'grant' || action === 'revoke') {
    const provider = args[1];
    if (provider === undefined || provider.length === 0) {
      log('error', `Usage: upwell consent ${action} <provider>`);
      return 2;
    }
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      log(
        'error',
        `Unknown provider '${provider}'. Supported: ${[...SUPPORTED_PROVIDERS].join(', ')}`,
      );
      return 2;
    }
    return action === 'grant' ? grantConsent(provider) : revokeConsent(provider);
  }
  log('error', 'Usage: upwell consent <list|grant|revoke> [provider]');
  return 2;
}

async function withDb<T>(fn: (db: DatabaseType) => T): Promise<T> {
  const db = await openCorpusDb();
  await migrate(db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function listConsent(): Promise<number> {
  return await withDb((db) => {
    const rows = db
      .prepare(
        'SELECT provider_id, granted_at, granted_by, scope FROM consent ORDER BY provider_id',
      )
      .all() as { provider_id: string; granted_at: number; granted_by: string; scope: string }[];
    if (rows.length === 0) {
      console.log('No consent grants on file.');
      return 0;
    }
    for (const row of rows) {
      console.log(
        `${row.provider_id}\tgranted_at=${new Date(row.granted_at).toISOString()}\tby=${row.granted_by}\tscope=${row.scope}`,
      );
    }
    return 0;
  });
}

async function grantConsent(provider: string): Promise<number> {
  return await withDb((db) => {
    db.prepare(
      `INSERT INTO consent (provider_id, granted_at, granted_by, scope)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET granted_at = excluded.granted_at`,
    ).run(provider, Date.now(), 'cli', 'all');
    log('info', `Granted consent for provider '${provider}'.`);
    return 0;
  });
}

async function revokeConsent(provider: string): Promise<number> {
  return await withDb((db) => {
    db.prepare('DELETE FROM consent WHERE provider_id = ?').run(provider);
    log('info', `Revoked consent for provider '${provider}'.`);
    return 0;
  });
}
