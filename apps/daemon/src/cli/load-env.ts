import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { config } from 'dotenv';
import { getDataDir } from '../util/data-dir.js';

export interface LoadedEnv {
  readonly loaded: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Load env vars from .env files into process.env. Search order:
 *   1. $RISEZOME_ENV_FILE (explicit override)
 *   2. <data dir>/.env       (persistent home, e.g. ~/.local/share/risezome/.env)
 *   3. ./.env                (current working directory)
 *   4. <workspace root>/.env (walks up from cwd looking for pnpm-workspace.yaml or .git)
 *
 * Already-set vars in process.env are never overwritten, so shell exports
 * always win over file values. Each file is loaded once; later files do
 * not clobber earlier files' values either.
 *
 * The workspace-root walk-up is what lets `pnpm --filter @risezome/daemon dev`
 * find the repo-root .env even though pnpm changes the cwd into apps/daemon/
 * before invoking the script.
 */
export function loadEnvFiles(): LoadedEnv {
  const candidates = candidatePaths();
  const loaded: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
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
  const explicit = process.env.RISEZOME_ENV_FILE;
  if (explicit !== undefined && explicit.length > 0) out.push(explicit);
  out.push(join(getDataDir(), '.env'));
  out.push(join(process.cwd(), '.env'));
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (workspaceRoot !== null) out.push(join(workspaceRoot, '.env'));
  return out;
}

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', '.git'];

function findWorkspaceRoot(startDir: string): string | null {
  const { root } = parse(startDir);
  let current = startDir;
  while (current !== root) {
    for (const marker of WORKSPACE_MARKERS) {
      if (existsSync(join(current, marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
