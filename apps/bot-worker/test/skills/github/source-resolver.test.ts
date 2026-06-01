import { describe, expect, it, vi } from 'vitest';
import { buildGithubSourceResolver } from '../../../src/skills/github/source-resolver.js';
import type { GithubAppAuth } from '../../../src/skills/github/app-auth.js';

/** Minimal Supabase query-builder stub returning canned source rows. */
function dbReturning(rows: unknown[] | null, error: { message: string } | null = null): {
  db: { from: (t: string) => unknown };
  capture: { eqs: [string, unknown][]; nots: unknown[][] };
} {
  const capture = { eqs: [] as [string, unknown][], nots: [] as unknown[][] };
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'not']) {
    builder[m] = (...args: unknown[]) => {
      if (m === 'eq') capture.eqs.push([args[0] as string, args[1]]);
      if (m === 'not') capture.nots.push(args);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error });
  return { db: { from: () => builder }, capture };
}

function fakeAppAuth(tokenByInstall: Record<number, string>): GithubAppAuth {
  return {
    installationToken: vi.fn(async (id: number) => tokenByInstall[id] ?? `tok_${String(id)}`),
  } as unknown as GithubAppAuth;
}

describe('buildGithubSourceResolver', () => {
  it('returns null when the org has no github sources', async () => {
    const { db } = dbReturning([]);
    const resolve = buildGithubSourceResolver({ db: db as never, appAuth: fakeAppAuth({}) });
    expect(await resolve('org1')).toBeNull();
  });

  it('groups repos by installation and mints one token per installation', async () => {
    const { db } = dbReturning([
      { installation_id: 10, repo_full_name: 'acme/widget' },
      { installation_id: 10, repo_full_name: 'acme/gadget' },
      { installation_id: 20, repo_full_name: 'other/thing' },
    ]);
    const appAuth = fakeAppAuth({ 10: 'tok10', 20: 'tok20' });
    const resolve = buildGithubSourceResolver({ db: db as never, appAuth });
    const access = await resolve('org1');
    expect(access).not.toBeNull();
    expect(access!.installations).toHaveLength(2);
    const inst10 = access!.installations.find((i) => i.installationId === 10)!;
    expect(inst10.token).toBe('tok10');
    expect(inst10.repos).toEqual([
      { owner: 'acme', name: 'widget' },
      { owner: 'acme', name: 'gadget' },
    ]);
    const inst20 = access!.installations.find((i) => i.installationId === 20)!;
    expect(inst20.repos).toEqual([{ owner: 'other', name: 'thing' }]);
  });

  it('scopes the query by org_id and requires non-null installation_id + repo_full_name', async () => {
    const { db, capture } = dbReturning([{ installation_id: 1, repo_full_name: 'a/b' }]);
    const resolve = buildGithubSourceResolver({ db: db as never, appAuth: fakeAppAuth({ 1: 't' }) });
    await resolve('org-xyz');
    expect(capture.eqs).toContainEqual(['org_id', 'org-xyz']);
    // GitHub rows identified by non-null GitHub columns, not `kind`.
    expect(capture.nots).toContainEqual(['installation_id', 'is', null]);
    expect(capture.nots).toContainEqual(['repo_full_name', 'is', null]);
  });

  it('skips malformed repo_full_name rows', async () => {
    const { db } = dbReturning([
      { installation_id: 1, repo_full_name: 'no-slash' },
      { installation_id: 1, repo_full_name: 'a/b' },
    ]);
    const resolve = buildGithubSourceResolver({ db: db as never, appAuth: fakeAppAuth({ 1: 't' }) });
    const access = await resolve('org1');
    expect(access!.installations[0]!.repos).toEqual([{ owner: 'a', name: 'b' }]);
  });

  it('throws when the sources query errors', async () => {
    const { db } = dbReturning(null, { message: 'boom' });
    const resolve = buildGithubSourceResolver({ db: db as never, appAuth: fakeAppAuth({}) });
    await expect(resolve('org1')).rejects.toThrow(/sources lookup failed/);
  });
});
