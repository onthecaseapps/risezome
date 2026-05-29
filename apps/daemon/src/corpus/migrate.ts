import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';
import { CorpusError } from './db.js';

interface MigrationFile {
  readonly version: number;
  readonly filename: string;
  readonly path: string;
}

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

const MIGRATION_FILENAME_RE = /^(\d{4})_.+\.sql$/;

export interface MigrationResult {
  readonly applied: number[];
  readonly skipped: number[];
}

export async function migrate(
  db: DatabaseType,
  migrationsDirOverride?: string,
): Promise<MigrationResult> {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const migrationsDir = migrationsDirOverride ?? defaultMigrationsDir();
  const migrations = await loadMigrationFiles(migrationsDir);

  const applied: number[] = [];
  const skipped: number[] = [];

  const alreadyApplied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  for (const m of migrations) {
    if (alreadyApplied.has(m.version)) {
      skipped.push(m.version);
      continue;
    }
    const sql = await readFile(m.path, 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)',
      ).run(m.version, m.filename, Date.now());
    });
    try {
      tx();
    } catch (err) {
      throw new CorpusError(
        'corpus-migration-failed',
        `Migration ${m.filename} failed: ${(err as Error).message}`,
        { cause: err },
      );
    }
    applied.push(m.version);
  }

  return { applied, skipped };
}

function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'migrations');
}

async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new CorpusError(
      'corpus-migrations-dir-missing',
      `Migrations directory not found at ${dir}.`,
      { cause: err },
    );
  }
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const match = MIGRATION_FILENAME_RE.exec(filename);
    if (match === null) continue;
    files.push({
      version: Number(match[1]),
      filename,
      path: join(dir, filename),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}
