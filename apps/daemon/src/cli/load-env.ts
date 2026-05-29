import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { getDataDir } from '../util/data-dir.js';

export interface LoadedEnv {
  readonly loaded: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Load env vars from .env files into process.env. Search order:
 *   1. $UPWELL_ENV_FILE (explicit override)
 *   2. <data dir>/.env  (persistent home, e.g. ~/.local/share/upwell/.env)
 *   3. ./.env           (current working directory)
 *
 * Already-set vars in process.env are never overwritten, so shell exports
 * always win over file values. Each file is loaded once; later files do
 * not clobber earlier files' values either.
 */
export function loadEnvFiles(): LoadedEnv {
  const candidates = candidatePaths();
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) {
      skipped.push(path);
      continue;
    }
    const result = config({ path, override: false, quiet: true });
    if (result.error !== undefined) {
      skipped.push(path);
      continue;
    }
    loaded.push(path);
  }
  return { loaded, skipped };
}

function candidatePaths(): string[] {
  const out: string[] = [];
  const explicit = process.env.UPWELL_ENV_FILE;
  if (explicit !== undefined && explicit.length > 0) out.push(explicit);
  out.push(join(getDataDir(), '.env'));
  out.push(join(process.cwd(), '.env'));
  return out;
}
