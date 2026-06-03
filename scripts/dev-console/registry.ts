import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProcDef } from './process-manager';

/**
 * The processes the dev console spawns + manages (plan U1). Supabase is NOT here
 * — it's driven by `supabase` CLI commands (see supabase-control.ts), not a
 * foreground child. `order` controls start-all (ascending) / stop-all (reverse);
 * Supabase is conceptually order 1, so these start at 2.
 *
 * The tunnel's config path is per-developer (risezome-dev-<tag>.yml), so the
 * registry is built with the active tag.
 */
export function appRegistry(repoRoot: string, tag: string): ProcDef[] {
  const tunnelConfig = join(homedir(), '.cloudflared', `risezome-dev-${tag}.yml`);
  return [
    {
      name: 'portal',
      command: 'pnpm',
      args: ['--filter', '@risezome/portal', 'dev'],
      cwd: repoRoot,
      order: 2,
      port: 3000,
    },
    {
      name: 'inngest',
      command: 'npx',
      args: ['inngest-cli@latest', 'dev'],
      cwd: repoRoot,
      order: 3,
      port: 8288,
    },
    {
      name: 'bot-worker',
      command: 'pnpm',
      args: ['--filter', '@risezome/bot-worker', 'dev'],
      cwd: repoRoot,
      order: 4,
      port: 8787,
    },
    {
      name: 'tunnel',
      command: 'cloudflared',
      args: ['tunnel', '--config', tunnelConfig, 'run'],
      cwd: repoRoot,
      order: 5,
      requiresConfigPath: tunnelConfig,
    },
  ];
}
