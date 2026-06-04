/**
 * One-time KMS backfill driver + verifier (security plan 003, U11).
 *
 * Drives the pgcrypto → per-org KMS-ESDK re-encryption from the CLI instead of
 * Inngest, so a local→hosted operator run is fully observable. Same logic: it
 * calls `migrateOrgEncryption` per org (which provisions the org CMK then
 * re-encrypts every column), then prints the runbook's verification counts.
 *
 * Modes:
 *   --verify   read-only: print org count + per-column legacy-row counts, exit.
 *   (default)  provision + re-encrypt every org, then print verification counts.
 *   --org <id> restrict to a single org (smoke-test first).
 *
 * Env (loaded via tsx --env-file=.env.local): SUPABASE url + service-role key,
 * USER_TOKEN_ENCRYPTION_KEY (legacy global key, to decrypt old rows), and the
 * AWS credential chain + AWS_REGION (per-org CMKs). Do NOT set
 * RISEZOME_DEV_CRYPTO_KEY for a hosted run — that selects the dev keyring.
 *
 * Usage (from apps/portal):
 *   pnpm tsx --env-file=.env.local scripts/kms-backfill.ts --verify
 *   pnpm tsx --env-file=.env.local scripts/kms-backfill.ts --org <uuid>
 *   pnpm tsx --env-file=.env.local scripts/kms-backfill.ts
 */
import { createServiceRoleClient } from '../app/_lib/supabase-server';
import { migrateOrgEncryption } from '../src/inngest/functions/migrate-encryption-to-kms';
import type { SupabaseClient } from '@supabase/supabase-js';

/** One legacy-row count: rows with non-null ciphertext whose version sentinel
 *  is still < KMS_ESDK (null or < 2). `enc`/`ver` name the column pair; the
 *  google-tokens row adds `key_org_id is null` as an extra legacy signal. */
interface CountSpec {
  label: string;
  table: string;
  enc: string;
  orFilter: string;
}

const COUNT_SPECS: CountSpec[] = [
  { label: 'meetings.recap_text_enc', table: 'meetings', enc: 'recap_text_enc', orFilter: 'recap_key_version.is.null,recap_key_version.lt.2' },
  { label: 'syntheses.accumulated_text_enc', table: 'syntheses', enc: 'accumulated_text_enc', orFilter: 'synth_key_version.is.null,synth_key_version.lt.2' },
  { label: 'meeting_events.transcript_text_enc', table: 'meeting_events', enc: 'transcript_text_enc', orFilter: 'transcript_key_version.is.null,transcript_key_version.lt.2' },
  { label: 'trello_connections.token_enc', table: 'trello_connections', enc: 'token_enc', orFilter: 'token_version.is.null,token_version.lt.2' },
  { label: 'user_google_tokens.refresh_token_enc', table: 'user_google_tokens', enc: 'refresh_token_enc', orFilter: 'key_version.is.null,key_version.lt.2,key_org_id.is.null' },
];

async function legacyCounts(service: SupabaseClient): Promise<{ label: string; legacy: number }[]> {
  const out: { label: string; legacy: number }[] = [];
  for (const spec of COUNT_SPECS) {
    const { count, error } = await service
      .from(spec.table)
      .select('*', { count: 'exact', head: true })
      .not(spec.enc, 'is', null)
      .or(spec.orFilter);
    out.push(
      error !== null
        ? { label: `${spec.label} (ERR: ${error.message})`, legacy: -1 }
        : { label: spec.label, legacy: count ?? 0 },
    );
  }
  return out;
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify');
  const orgArgIx = process.argv.indexOf('--org');
  const onlyOrg = orgArgIx !== -1 ? process.argv[orgArgIx + 1] : undefined;
  const service = createServiceRoleClient();

  const { data: orgRows, error: orgErr } = await service.from('orgs').select('id, name');
  if (orgErr !== null) throw new Error(`read orgs failed: ${orgErr.message}`);
  const orgs = (orgRows ?? []) as { id: string; name: string | null }[];
  const targets = onlyOrg !== undefined ? orgs.filter((o) => o.id === onlyOrg) : orgs;

  process.stderr.write(`Orgs: ${orgs.length} total${onlyOrg !== undefined ? ` · targeting ${onlyOrg}` : ''}\n`);

  process.stderr.write('\n=== BEFORE — legacy (pre-KMS) row counts ===\n');
  for (const r of await legacyCounts(service)) {
    process.stderr.write(`  ${r.legacy === 0 ? '✓' : '•'} ${r.label}: ${r.legacy}\n`);
  }
  process.stderr.write('  (atlassian_connections has no version sentinel — verified by decrypt probe during the run)\n');

  if (verifyOnly) {
    process.stderr.write('\n--verify: read-only, no changes made.\n');
    return;
  }

  process.stderr.write('\n=== MIGRATING ===\n');
  for (const org of targets) {
    process.stderr.write(`  org ${org.id} (${org.name ?? '—'}) …\n`);
    const result = await migrateOrgEncryption(service, org.id);
    for (const c of result.columns) {
      process.stderr.write(`     ${c.column}: scanned ${c.scanned} · migrated ${c.migrated} · skipped ${c.skipped}\n`);
    }
  }

  process.stderr.write('\n=== AFTER — legacy row counts (must all be 0) ===\n');
  let remaining = 0;
  for (const r of await legacyCounts(service)) {
    if (r.legacy > 0) remaining += r.legacy;
    process.stderr.write(`  ${r.legacy === 0 ? '✓' : '✗'} ${r.label}: ${r.legacy}\n`);
  }
  process.stderr.write(
    remaining === 0
      ? '\n✅ Zero legacy rows remain. Safe to apply 20260608000000_drop_pgcrypto_secret_helpers.\n'
      : `\n⚠️  ${remaining} legacy row(s) remain — re-run before applying the drop migration.\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
