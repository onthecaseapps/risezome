import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectorError, type AuthResult } from '../contract.js';

export class CloneError extends ConnectorError {
  constructor(message: string, options?: ErrorOptions) {
    super('connector-clone', message, options);
  }
}

export interface CloneOptions {
  readonly ownerRepo: string;
  readonly auth: AuthResult;
  readonly cacheDir: string;
  readonly depth?: number;
  readonly maxRepoBytes?: number;
}

export interface CloneResult {
  readonly path: string;
  readonly cached: boolean;
}

const DEFAULT_DEPTH = 1;
const DEFAULT_MAX_REPO_BYTES = 250 * 1024 * 1024;

/**
 * Plan U7 hardened git clone flags:
 *   core.symlinks=false core.protectHFS=true core.protectNTFS=true --no-hardlinks
 *   GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
 * Each of these closes a specific attack path tied to attacker-controlled
 * .gitattributes / .gitconfig / filter content.
 */
export async function ensureClone(options: CloneOptions): Promise<CloneResult> {
  const repoPath = join(options.cacheDir, sanitizeRepoPath(options.ownerRepo));
  await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });

  const existing = await pathExists(repoPath);
  if (existing) {
    return { path: repoPath, cached: true };
  }

  await runGit(['--version'], { extraEnv: hardenedEnv(), timeoutMs: 5_000 }).catch((err) => {
    throw new CloneError(`git is not available on PATH: ${(err as Error).message}`, { cause: err });
  });

  const url = buildAuthUrl(options.ownerRepo, options.auth);
  const depth = options.depth ?? DEFAULT_DEPTH;
  const args = [
    '-c',
    'core.symlinks=false',
    '-c',
    'core.protectHFS=true',
    '-c',
    'core.protectNTFS=true',
    '-c',
    'transfer.fsckObjects=true',
    'clone',
    '--depth',
    String(depth),
    '--no-hardlinks',
    '--single-branch',
    url,
    repoPath,
  ];

  try {
    await runGit(args, { extraEnv: hardenedEnv(), timeoutMs: 120_000 });
  } catch (err) {
    await rm(repoPath, { recursive: true, force: true });
    throw new CloneError(`git clone failed for ${options.ownerRepo}`, { cause: err });
  }

  const sizeOk = await enforceMaxBytes(repoPath, options.maxRepoBytes ?? DEFAULT_MAX_REPO_BYTES);
  if (!sizeOk) {
    await rm(repoPath, { recursive: true, force: true });
    throw new CloneError(
      `cloned repo ${options.ownerRepo} exceeds maxRepoBytes; refusing to index.`,
    );
  }

  return { path: repoPath, cached: false };
}

export async function discardClone(cacheDir: string, ownerRepo: string): Promise<void> {
  await rm(join(cacheDir, sanitizeRepoPath(ownerRepo)), { recursive: true, force: true });
}

function sanitizeRepoPath(ownerRepo: string): string {
  return ownerRepo.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function hardenedEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
  };
}

function buildAuthUrl(ownerRepo: string, auth: AuthResult): string {
  const token = auth.kind === 'pat' ? auth.token : auth.accessToken;
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${ownerRepo}.git`;
}

interface RunGitOptions {
  readonly extraEnv: Record<string, string>;
  readonly timeoutMs: number;
}

function runGit(args: readonly string[], options: RunGitOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, ...options.extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CloneError(`git timed out after ${String(options.timeoutMs)}ms`));
    }, options.timeoutMs);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new CloneError(`git exited with code ${String(code)}: ${stderr}`));
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function enforceMaxBytes(dir: string, maxBytes: number): Promise<boolean> {
  const total = await dirSize(dir, maxBytes);
  return total <= maxBytes;
}

async function dirSize(dir: string, abortAtBytes: number): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        const s = await stat(full);
        total += s.size;
        if (total > abortAtBytes) return total;
      }
    }
  }
  return total;
}
