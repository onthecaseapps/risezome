import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { RisezomeError } from '@risezome/shared-types';
import { getDataDir } from '../util/data-dir.js';

export const DEFAULT_DB_FILENAME = 'risezome.db';
export const DEFAULT_EMBEDDING_DIM = 1024;

export class CorpusError extends RisezomeError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export interface OpenCorpusOptions {
  readonly path?: string;
  readonly dataDirOverride?: string;
}

export async function resolveDbPath(options: OpenCorpusOptions): Promise<string> {
  if (options.path !== undefined) return options.path;
  const dir = getDataDir(options.dataDirOverride);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return join(dir, DEFAULT_DB_FILENAME);
}

export async function openCorpusDb(options: OpenCorpusOptions = {}): Promise<DatabaseType> {
  const dbPath = await resolveDbPath(options);
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);

  try {
    sqliteVec.load(db);
  } catch (err) {
    db.close();
    throw new CorpusError(
      'corpus-vec-load',
      `Failed to load sqlite-vec extension. Verify the package shipped a binary for your platform.`,
      { cause: err },
    );
  }

  try {
    const ftsCheck = db.prepare("SELECT name FROM pragma_module_list WHERE name = 'fts5'").get() as
      | { name?: string }
      | undefined;
    if (ftsCheck?.name !== 'fts5') {
      throw new CorpusError(
        'corpus-fts5-missing',
        'FTS5 is not available in this SQLite build. Use better-sqlite3, not node:sqlite — node:sqlite does not ship FTS5.',
      );
    }
  } catch (err) {
    if (err instanceof CorpusError) {
      db.close();
      throw err;
    }
  }

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.pragma('temp_store = MEMORY');

  if (process.platform !== 'win32') {
    try {
      await chmod(dbPath, 0o600);
    } catch {
      // Best-effort; non-POSIX platforms tolerate.
    }
  }

  return db;
}
