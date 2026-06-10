import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CRYPTO_VERSION,
  decryptForOrgFromBytea,
  encryptForOrgToBytea,
  EnvelopeCryptoError,
} from '@risezome/crypto';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { provisionOrgKey } from './provision-org-key';
import { DEFAULT_BATCH_SIZE, ENCRYPTED_COLUMNS } from '../lib/encrypted-columns';

/**
 * One-time re-encryption migration: global pgcrypto → per-org KMS envelope
 * (security plan 003, U11; KTD7).
 *
 * The cutover code (U9/U10) reads ONLY the new KMS-ESDK format. This backfill
 * converts every pre-existing ciphertext written under the global
 * `USER_TOKEN_ENCRYPTION_KEY` (pgcrypto OpenPGP/AES-256) into the per-org
 * envelope format so the cutover code can read it. On a real deploy it MUST run
 * AFTER the cutover code ships but BEFORE legacy rows are read at scale, and the
 * legacy pgcrypto SQL helpers (decrypt_refresh_token) MUST still be present — it
 * decrypts the old rows through them. The U13 drop migration runs only after
 * this backfill has verified zero rows remain < KMS_ESDK. See
 * docs/runbooks/encryption-kms-migration.md.
 *
 * Per org it (a) ensures the org's CMK is provisioned (U8 provisionOrgKey,
 * idempotent), then (b) walks each encrypted column, decrypts legacy rows via
 * the pgcrypto rpc + the global key, re-encrypts via encryptForOrgToBytea, and
 * writes the new ciphertext + stamps the row's version to KMS_ESDK.
 *
 * Idempotent + resumable: the per-row `*_version` columns are the progress
 * marker. A row already at KMS_ESDK is skipped, so re-running (or resuming after
 * an interruption) never double-encrypts. A write landing under the old key
 * mid-pass is a straggler the next pass catches (KTD7).
 *
 * Atlassian rows: `atlassian_connections.token_version` is an optimistic-
 * concurrency counter (it increments per rotation), NOT a crypto-format
 * sentinel — so it cannot mark "legacy" the way the other version columns do.
 * We therefore identify legacy atlassian rows by PROBING: attempt an ESDK
 * decrypt (decryptForOrgFromBytea); if it succeeds the row is already KMS and is
 * skipped, if it throws an EnvelopeCryptoError the bytes are legacy pgcrypto and
 * we migrate them (decrypt-old → re-encrypt). The OC counter is left untouched
 * so concurrent rotation guards keep working.
 *
 * The legacy global key lives only in USER_TOKEN_ENCRYPTION_KEY (env, never in
 * the DB) and is read here exactly as the pre-cutover code read it; this is the
 * one remaining app reference to it (removed in U13 once the backfill is done).
 */

/** Per-column backfill outcome, surfaced for the runbook's verification step. */
export interface ColumnMigrationResult {
  /** Logical name of the column migrated (table.column). */
  readonly column: string;
  /** Rows examined that were still on a legacy version. */
  readonly scanned: number;
  /** Rows actually re-encrypted to KMS_ESDK this pass. */
  readonly migrated: number;
  /** Rows skipped because they were already at KMS_ESDK (idempotent re-run). */
  readonly skipped: number;
}

export interface OrgMigrationResult {
  readonly orgId: string;
  readonly columns: ColumnMigrationResult[];
}

function requireLegacyKey(): string {
  const key = process.env['USER_TOKEN_ENCRYPTION_KEY'];
  if (key === undefined || key.length === 0) {
    throw new Error(
      'Missing USER_TOKEN_ENCRYPTION_KEY: the U11 backfill needs the legacy global key to decrypt pre-KMS rows',
    );
  }
  return key;
}

/**
 * Decrypt a legacy pgcrypto ciphertext (a bytea column read back as a `\x<hex>`
 * string) via the still-present `public.decrypt_refresh_token` rpc + the global
 * key. This is the ONLY place left that calls the legacy decrypt path; it is
 * removed together with the rpc in U13 after the backfill is verified.
 */
async function decryptLegacy(service: SupabaseClient, ciphertext: string): Promise<string> {
  const { data, error } = (await service.rpc('decrypt_refresh_token', {
    ciphertext,
    key: requireLegacyKey(),
  })) as { data: string | null; error: { message: string } | null };
  if (error !== null || data === null) {
    throw new Error(`legacy decrypt_refresh_token failed: ${error?.message ?? 'returned null'}`);
  }
  return data;
}

/**
 * Migrate a single org-scoped, version-marked encrypted column (the five non-
 * atlassian columns). Pages rows whose version sentinel is < KMS_ESDK (0 and 1
 * both mean legacy), decrypts via pgcrypto, re-encrypts under the org key, and
 * stamps the version to KMS_ESDK. Resumable: every migrated row leaves the
 * legacy version set behind, so a re-run only sees what is still legacy.
 */
async function migrateVersionedColumn(
  service: SupabaseClient,
  orgId: string,
  opts: {
    table: string;
    pk: string;
    encColumn: string;
    versionColumn: string;
    batchSize: number;
  },
): Promise<ColumnMigrationResult> {
  const { table, pk, encColumn, versionColumn, batchSize } = opts;
  let scanned = 0;
  let migrated = 0;

  // Loop until a pass returns no legacy rows. Because each migrated row's version
  // is bumped out of the `< KMS_ESDK` filter, the same offset window keeps
  // surfacing fresh legacy rows — no manual offset paging needed (and none that
  // could skip a straggler).
  for (;;) {
    const { data, error } = await service
      .from(table)
      .select(`${pk}, ${encColumn}, ${versionColumn}`)
      .eq('org_id', orgId)
      .lt(versionColumn, CRYPTO_VERSION.KMS_ESDK)
      .limit(batchSize);
    if (error !== null) {
      throw new Error(`U11 read ${table}.${encColumn} failed: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const enc = row[encColumn] as string | null;
      const id = row[pk];
      if (enc === null) {
        // No ciphertext to migrate (e.g. a null transcript on a non-transcript
        // event); stamp it forward so it leaves the legacy filter and the pass
        // terminates.
        const { error: upErr } = await service
          .from(table)
          .update({ [versionColumn]: CRYPTO_VERSION.KMS_ESDK })
          .eq(pk, id)
          .eq('org_id', orgId);
        if (upErr !== null) {
          throw new Error(
            `U11 version-stamp ${table}.${pk}=${String(id)} failed: ${upErr.message}`,
          );
        }
        continue;
      }
      const plaintext = await decryptLegacy(service, enc);
      const reEnc = await encryptForOrgToBytea(orgId, plaintext);
      const { error: upErr } = await service
        .from(table)
        .update({ [encColumn]: reEnc, [versionColumn]: CRYPTO_VERSION.KMS_ESDK })
        .eq(pk, id)
        .eq('org_id', orgId)
        // Guard against a concurrent KMS write landing between read and write:
        // only migrate while the row is still legacy.
        .lt(versionColumn, CRYPTO_VERSION.KMS_ESDK);
      if (upErr !== null) {
        throw new Error(`U11 write ${table}.${pk}=${String(id)} failed: ${upErr.message}`);
      }
      migrated += 1;
    }
  }

  return { column: `${table}.${encColumn}`, scanned, migrated, skipped: scanned - migrated };
}

/**
 * Migrate user_google_tokens.refresh_token_enc. Special-cased vs. the generic
 * versioned-column helper because (a) the table has no org_id — the token is
 * encrypted under the user's ORG-OF-RECORD (oldest membership; KTD4) — and (b)
 * the migration must additionally set key_org_id so decrypt can resolve the CMK.
 * Only rows belonging to the org being migrated are touched.
 */
async function migrateGoogleTokensForOrg(
  service: SupabaseClient,
  orgId: string,
  userIds: string[],
): Promise<ColumnMigrationResult> {
  let scanned = 0;
  let migrated = 0;
  if (userIds.length === 0) {
    return { column: 'user_google_tokens.refresh_token_enc', scanned, migrated, skipped: 0 };
  }

  const { data, error } = await service
    .from('user_google_tokens')
    .select('user_id, refresh_token_enc, key_version')
    .in('user_id', userIds)
    .lt('key_version', CRYPTO_VERSION.KMS_ESDK);
  if (error !== null) {
    throw new Error(`U11 read user_google_tokens failed: ${error.message}`);
  }
  const rows = (data ?? []) as {
    user_id: string;
    refresh_token_enc: string | null;
    key_version: number | null;
  }[];

  for (const row of rows) {
    scanned += 1;
    if (row.refresh_token_enc === null) {
      const { error: upErr } = await service
        .from('user_google_tokens')
        .update({ key_version: CRYPTO_VERSION.KMS_ESDK, key_org_id: orgId })
        .eq('user_id', row.user_id);
      if (upErr !== null) {
        throw new Error(`U11 google-token stamp ${row.user_id} failed: ${upErr.message}`);
      }
      continue;
    }
    const plaintext = await decryptLegacy(service, row.refresh_token_enc);
    const reEnc = await encryptForOrgToBytea(orgId, plaintext);
    const { error: upErr } = await service
      .from('user_google_tokens')
      .update({
        refresh_token_enc: reEnc,
        key_version: CRYPTO_VERSION.KMS_ESDK,
        key_org_id: orgId,
      })
      .eq('user_id', row.user_id)
      .lt('key_version', CRYPTO_VERSION.KMS_ESDK);
    if (upErr !== null) {
      throw new Error(`U11 google-token write ${row.user_id} failed: ${upErr.message}`);
    }
    migrated += 1;
  }

  return {
    column: 'user_google_tokens.refresh_token_enc',
    scanned,
    migrated,
    skipped: scanned - migrated,
  };
}

/**
 * Migrate atlassian_connections for one org. token_version is an OC counter, so
 * we identify legacy rows by PROBING: attempt an ESDK decrypt; success ⇒ already
 * KMS (skip), EnvelopeCryptoError ⇒ legacy pgcrypto (migrate). Both access and
 * refresh ciphertext are migrated together. token_version is left untouched.
 */
/**
 * Decide whether a failed ESDK decrypt of an atlassian row means "this row is
 * legacy pgcrypto" (migrate it) vs. "KMS is having a transient problem" (abort).
 *
 * The probe relies on decrypt THROWING on a legacy row — but it also throws on a
 * transient KMS outage (5xx / throttle), which is wrapped identically as an
 * `EnvelopeCryptoError`. Treating a transient outage as "legacy" would re-run the
 * pgcrypto decrypt against a row that is ALREADY KMS-encrypted, corrupting it.
 *
 * So we inspect the wrapped cause: a transient AWS KMS service exception (an
 * `$metadata.httpStatusCode` in the 5xx range, or a throttling/internal/
 * unavailable error name) means RETHROW — abort the migration and let Inngest
 * retry. An ESDK format/decrypt error (the bytes simply are not a valid ESDK
 * message — i.e. they are legacy pgcrypto) means the row IS legacy → migrate.
 */
export function isTransientKmsError(err: EnvelopeCryptoError): boolean {
  const cause = (err as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== 'object') return false;
  const c = cause as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const status = c.$metadata?.httpStatusCode;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const name = typeof c.name === 'string' ? c.name : '';
  // AWS SDK service-exception names for transient/retryable KMS failures.
  return (
    name === 'ThrottlingException' ||
    name === 'KMSInternalException' ||
    name === 'InternalFailure' ||
    name === 'ServiceUnavailable' ||
    name === 'KeyUnavailableException' ||
    name === 'DependencyTimeoutException' ||
    name === 'TimeoutError' ||
    /throttl/i.test(name)
  );
}

async function migrateAtlassianForOrg(
  service: SupabaseClient,
  orgId: string,
): Promise<ColumnMigrationResult> {
  let scanned = 0;
  let migrated = 0;

  const { data, error } = await service
    .from('atlassian_connections')
    .select('id, access_token_enc, refresh_token_enc, token_version')
    .eq('org_id', orgId);
  if (error !== null) {
    throw new Error(`U11 read atlassian_connections failed: ${error.message}`);
  }
  const rows = (data ?? []) as {
    id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    token_version: number;
  }[];

  for (const row of rows) {
    if (row.access_token_enc === null || row.refresh_token_enc === null) continue;
    scanned += 1;

    // Probe: if the access ciphertext already decrypts under the org's KMS key,
    // the row is migrated — skip it (idempotent / resumable). If it throws an
    // EnvelopeCryptoError we must distinguish a legacy-pgcrypto row (migrate)
    // from a TRANSIENT KMS error (abort) — see isTransientKmsError.
    let isLegacy = false;
    try {
      await decryptForOrgFromBytea(orgId, row.access_token_enc);
    } catch (err) {
      if (err instanceof EnvelopeCryptoError) {
        if (isTransientKmsError(err)) {
          // Transient KMS failure: do NOT treat as legacy (that would re-run the
          // pgcrypto path on an already-KMS row and corrupt it). Abort; Inngest
          // retries the whole migration step.
          throw err;
        }
        isLegacy = true;
      } else {
        throw err;
      }
    }
    if (!isLegacy) continue;

    const [access, refresh] = await Promise.all([
      decryptLegacy(service, row.access_token_enc),
      decryptLegacy(service, row.refresh_token_enc),
    ]);
    const [accessEnc, refreshEnc] = await Promise.all([
      encryptForOrgToBytea(orgId, access),
      encryptForOrgToBytea(orgId, refresh),
    ]);
    // Optimistic-concurrency guard: only write if token_version is unchanged
    // since we read it. A concurrent token refresh (getValidAtlassianToken)
    // increments token_version and rewrites the ciphertext; without this guard
    // the migration would clobber that fresh rotation with stale re-encrypted
    // bytes, killing the connection. If we lose the race (0 rows updated), the
    // winner already wrote KMS-format ciphertext, so skipping this row is correct.
    const { data: upData, error: upErr } = await service
      .from('atlassian_connections')
      .update({ access_token_enc: accessEnc, refresh_token_enc: refreshEnc })
      .eq('id', row.id)
      .eq('org_id', orgId)
      .eq('token_version', row.token_version)
      .select('id');
    if (upErr !== null) {
      throw new Error(`U11 atlassian write ${row.id} failed: ${upErr.message}`);
    }
    if (Array.isArray(upData) && upData.length > 0) {
      migrated += 1;
    }
  }

  return {
    column: 'atlassian_connections.{access,refresh}_token_enc',
    scanned,
    migrated,
    skipped: scanned - migrated,
  };
}

/**
 * Re-encrypt every encrypted column for a SINGLE org. Ensures the org key is
 * provisioned first (U8), then migrates each column. Idempotent + resumable.
 * Returns per-column counts for the runbook's verification step.
 */
export async function migrateOrgEncryption(
  service: SupabaseClient,
  orgId: string,
  opts: { batchSize?: number } = {},
): Promise<OrgMigrationResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  // (a) Ensure the org's CMK exists (idempotent; dev fallback = pure DB record).
  await provisionOrgKey(orgId, service);

  // (b) Resolve the org's members so we can migrate their Google tokens under
  // this org's key (only when this org IS their org-of-record — see below).
  const userIds = await orgMembersWhereOrgOfRecord(service, orgId);

  const columns: ColumnMigrationResult[] = [];

  // The org-scoped, version-marked columns (shared descriptor list).
  for (const col of ENCRYPTED_COLUMNS) {
    columns.push(await migrateVersionedColumn(service, orgId, { ...col, batchSize }));
  }

  // Atlassian (probe-based, OC counter untouched).
  columns.push(await migrateAtlassianForOrg(service, orgId));

  // Google tokens (per-user, keyed by org-of-record).
  columns.push(await migrateGoogleTokensForOrg(service, orgId, userIds));

  return { orgId, columns };
}

/**
 * The user_ids whose ORG-OF-RECORD (oldest membership; KTD4) is `orgId`. The
 * Google refresh token is encrypted under exactly one org per user, so we only
 * migrate a user's token while processing that user's org-of-record — otherwise
 * a multi-org user's token would be re-encrypted (and key_org_id flipped) once
 * per org. Resolved from org_members ordered by join time.
 */
async function orgMembersWhereOrgOfRecord(
  service: SupabaseClient,
  orgId: string,
): Promise<string[]> {
  // Defensive cap: org_members is read whole here (org-of-record spans all of a
  // user's memberships), but an unbounded full-table read could blow memory at
  // scale. We bound the read and warn if we hit the cap so it surfaces before it
  // silently truncates org-of-record resolution. Ordered by user_id then
  // joined_at so the first row per user (the cap-stable oldest membership) wins
  // deterministically even at the boundary.
  const ORG_MEMBERS_READ_CAP = 100_000;
  // service-role-cross-org: org-of-record is defined ACROSS all of a user's
  // memberships (the oldest one wins, KTD4), so resolving it is inherently a
  // cross-org read; we then filter to the target org in memory below.
  const { data, error } = await service
    .from('org_members')
    .select('user_id, org_id, joined_at')
    .order('user_id', { ascending: true })
    .order('joined_at', { ascending: true })
    .limit(ORG_MEMBERS_READ_CAP);
  if (error !== null) {
    throw new Error(`U11 org_members read failed: ${error.message}`);
  }
  const rows = (data ?? []) as { user_id: string; org_id: string; joined_at: string }[];
  if (rows.length >= ORG_MEMBERS_READ_CAP) {
    console.warn(
      `[migrate-encryption] org_members read hit the ${ORG_MEMBERS_READ_CAP}-row cap; ` +
        `org-of-record resolution may be truncated. Move this to a DISTINCT ON(user_id) RPC.`,
    );
  }
  const orgOfRecord = new Map<string, string>();
  for (const r of rows) {
    if (!orgOfRecord.has(r.user_id)) orgOfRecord.set(r.user_id, r.org_id);
  }
  return [...orgOfRecord.entries()]
    .filter(([, recordOrg]) => recordOrg === orgId)
    .map(([userId]) => userId);
}

/** All org ids, for a full backfill across the instance. */
async function allOrgIds(service: SupabaseClient): Promise<string[]> {
  const { data, error } = await service.from('orgs').select('id');
  if (error !== null) {
    throw new Error(`U11 orgs read failed: ${error.message}`);
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/**
 * Inngest wrapper: run the backfill across every org (or a single org if an
 * `orgId` is supplied on the event). Triggered manually
 * (`risezome/encryption.migrate-to-kms`) during the deploy window. Resumable —
 * safe to re-send the event; already-migrated rows are skipped.
 */
export const migrateEncryptionToKmsFn = inngest.createFunction(
  {
    id: 'migrate-encryption-to-kms',
    name: 'One-time re-encryption: pgcrypto → per-org KMS envelope',
    retries: 3,
    triggers: [{ event: 'risezome/encryption.migrate-to-kms' }],
  },
  async ({ event, step }) => {
    const data = (event as unknown as { data?: { orgId?: string; batchSize?: number } }).data ?? {};
    const service = createServiceRoleClient();
    const orgIds =
      data.orgId !== undefined
        ? [data.orgId]
        : ((await step.run('list-orgs', () => allOrgIds(service))) as string[]);
    const opts = data.batchSize !== undefined ? { batchSize: data.batchSize } : {};
    const results: OrgMigrationResult[] = [];
    for (const orgId of orgIds) {
      // Durable per-org checkpoint: a retry resumes after the last fully
      // migrated org instead of restarting the whole instance from row 0
      // (the per-row version sentinels make a re-run cheap, but not free).
      results.push(
        (await step.run(`migrate-org-${orgId}`, () =>
          migrateOrgEncryption(service, orgId, opts),
        )) as OrgMigrationResult,
      );
    }
    return { orgs: results.length, results };
  },
);
