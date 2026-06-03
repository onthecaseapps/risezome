import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Fixture-driven tests for the cross-org scoping guard.
 *
 * We stage a throwaway repo layout (migrations + a service-role module +
 * an apps/portal/app source dir) and run the REAL checker against it by
 * pointing CHECK_ORG_SCOPE_ROOT at the fixture (so `typescript` still
 * resolves from the real install). The checker exits 0 (clean) or 1
 * (violations) and prints `path:line: <message>` for each violation —
 * exactly the contract CI relies on.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_CHECKER = join(__dirname, '..', 'check-service-role-org-scope.mjs');

let root: string;

/** Run the real checker against the fixture root. Returns { code, out, err }. */
function runChecker(): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('node', [REAL_CHECKER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CHECK_ORG_SCOPE_ROOT: root },
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'org-scope-guard-'));

  // ── Migrations: gaps has org_id (org-scoped); profiles does NOT ──────────
  write(
    'supabase/migrations/0001_gaps.sql',
    `create table public.gaps (
       gap_id uuid primary key,
       org_id uuid not null references public.orgs(id),
       title text
     );`,
  );
  write(
    'supabase/migrations/0002_profiles.sql',
    `-- this comment mentions org_id but must NOT make profiles org-scoped
     create table public.profiles (
       user_id uuid primary key,
       display_name text
     );`,
  );
  // alter-table add column path
  write(
    'supabase/migrations/0003_widgets.sql',
    `create table public.widgets ( widget_id uuid primary key, label text );
     alter table public.widgets add column org_id uuid not null;`,
  );

  // Minimal supabase-server stub so the import paths look real (not parsed
  // for client identity, but keeps the tree realistic).
  write('apps/portal/app/_lib/supabase-server.ts', `export const x = 1;`);
});

/** (Re)write the mutable source fixtures before each test for isolation. */
beforeEach(() => {
  // ── A service-role module (param-injected client): every org-scoped
  //    .from chain is checked. One scoped (OK), one unscoped (violation). ──
  write(
    'apps/bot-worker/src/retrieval.ts',
    `export async function work(db: any, orgId: string) {
       // scoped: passes
       await db.from('gaps').update({ title: 'x' }).eq('gap_id', 'g').eq('org_id', orgId);
       // unscoped: should FAIL (line tracked below)
       await db.from('gaps').update({ title: 'y' }).eq('gap_id', 'g');
     }`,
  );

  // ── Portal app sources ──────────────────────────────────────────────────
  // Authenticated (RLS-respecting) client: NOT flagged even when unscoped.
  write(
    'apps/portal/app/authed.ts',
    `import { createServerClient } from './_lib/supabase-server';
     export async function read() {
       const supa = await createServerClient();
       return supa.from('gaps').select('*').eq('gap_id', 'g'); // RLS client → ignored
     }`,
  );

  // Service-role client via factory: unscoped on an org table → violation,
  // unless annotated. Includes a non-org table (ignored) and an annotated one.
  write(
    'apps/portal/app/actions.ts',
    `import { createServiceRoleClient } from './_lib/supabase-server';
     export async function a() {
       const svc = createServiceRoleClient();
       // unscoped service-role on org table → VIOLATION
       await svc.from('gaps').update({ title: 'z' }).eq('gap_id', 'g');
       // non-org table → ignored even though unscoped
       await svc.from('profiles').update({ display_name: 'n' }).eq('user_id', 'u');
       // annotated genuine cross-org job → OK
       // service-role-cross-org: background reconcile sweep across all orgs
       await svc.from('gaps').delete().lt('created_at', 'cutoff');
       // insert carrying org_id in the payload → OK (org-bound by value)
       await svc.from('widgets').insert({ widget_id: 'w', org_id: 'o', label: 'l' });
       // scoped read → OK
       await svc.from('gaps').select('*').eq('org_id', 'o');
     }`,
  );

  // A raw createClient(...) with the service-role secret env marker is
  // service-role too; unscoped on an org table → violation.
  write(
    'apps/portal/app/raw.ts',
    `import { createClient } from '@supabase/supabase-js';
     export function mk() {
       const c = createClient(process.env.URL!, process.env.SUPABASE_SECRET_KEY!);
       return c.from('gaps').select('*').eq('gap_id', 'g'); // service-role, unscoped → VIOLATION
     }`,
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-service-role-org-scope', () => {
  it('reports exactly the expected violations and exits non-zero', () => {
    const { code, err } = runChecker();
    expect(code).toBe(1);

    // retrieval.ts service-role module: the unscoped .from('gaps') update.
    expect(err).toMatch(/apps\/bot-worker\/src\/retrieval\.ts:\d+: .*'gaps'.*org_id/);
    // factory-bound service client, unscoped org-table write.
    expect(err).toMatch(/apps\/portal\/app\/actions\.ts:\d+: .*'gaps'.*org_id/);
    // raw createClient with secret env marker.
    expect(err).toMatch(/apps\/portal\/app\/raw\.ts:\d+: .*'gaps'.*org_id/);
  });

  it('does NOT flag the authenticated (RLS) client', () => {
    const { err } = runChecker();
    expect(err).not.toMatch(/authed\.ts/);
  });

  it('does NOT flag a non-org-scoped table (profiles)', () => {
    const { err } = runChecker();
    expect(err).not.toMatch(/'profiles'/);
  });

  it('does NOT flag an annotated cross-org statement', () => {
    const { err } = runChecker();
    // The only actions.ts violation is the gaps update; the annotated delete
    // and the scoped/insert lines must not appear. Count actions.ts lines.
    const actionsHits = err.split('\n').filter((l) => l.includes('actions.ts')).length;
    expect(actionsHits).toBe(1);
  });

  it('passes cleanly (exit 0) when every org-scoped query is scoped or annotated', () => {
    // Overwrite the violating files with fully-scoped variants.
    write(
      'apps/bot-worker/src/retrieval.ts',
      `export async function work(db: any, orgId: string) {
         await db.from('gaps').update({ title: 'x' }).eq('gap_id', 'g').eq('org_id', orgId);
       }`,
    );
    write(
      'apps/portal/app/actions.ts',
      `import { createServiceRoleClient } from './_lib/supabase-server';
       export async function a() {
         const svc = createServiceRoleClient();
         await svc.from('gaps').update({ title: 'z' }).eq('gap_id', 'g').eq('org_id', 'o');
       }`,
    );
    write(
      'apps/portal/app/raw.ts',
      `import { createClient } from '@supabase/supabase-js';
       export function mk() {
         const c = createClient(process.env.URL!, process.env.SUPABASE_SECRET_KEY!);
         return c.from('gaps').select('*').eq('gap_id', 'g').eq('org_id', 'o');
       }`,
    );

    const { code, out } = runChecker();
    expect(code).toBe(0);
    expect(out).toMatch(/0 violations/);
    // The derived org set must include gaps + widgets but not profiles.
    expect(out).toMatch(/org-scoped tables/);
  });
});
