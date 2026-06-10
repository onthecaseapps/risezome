import type { SupabaseClient } from '@supabase/supabase-js';
import { CRYPTO_VERSION, decryptForOrgFromBytea, encryptForOrgToBytea } from '@risezome/crypto';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { DEFAULT_BATCH_SIZE, ENCRYPTED_COLUMNS } from '../lib/encrypted-columns';

/**
 * Per-org key rotation + revocation (security plan 003, U12; KTD2/R4).
 *
 * Supersedes the old global `public.rewrap_encrypted_secrets` SQL procedure (a
 * single statement that re-wrapped EVERY org's rows under one new global key).
 * Under the per-org KMS envelope scheme rotation is per-org and isolated:
 *
 *   - CMK rotation: the wrapping CMK rotates automatically (KMS annual key
 *     rotation) with no data rewrite — old data keys stay decryptable. That path
 *     is an AWS console / Terraform setting, nothing to run here.
 *   - Data-key / per-org re-encryption: this function. It re-encrypts ONE org's
 *     encrypted rows so every ciphertext is freshly wrapped under a new data key
 *     (and, after a CMK rotation, under the new CMK material). It is the
 *     mechanism behind a clean per-org re-key, and is scoped strictly to the
 *     target org — no other org's bytes are read or written.
 *   - Revocation: disable the org's CMK in AWS KMS (`disableOrgKey` marks
 *     org_encryption_keys.status='revoked' as the operational record; the actual
 *     instant revocation is disabling the CMK in KMS, after which every decrypt
 *     for that org throws — the data is cryptographically unreadable until the
 *     CMK is re-enabled). See docs/runbooks/encryption-key-rotation.md.
 *
 * Decrypt-then-re-encrypt both go through @risezome/crypto, so the new write is
 * the canonical KMS-ESDK format and the per-org caching CMM collapses the KMS
 * traffic. Idempotent at the row level (a re-run simply re-wraps again); scoped
 * to a single org by every query filtering on org_id (or, for atlassian/google,
 * the org's connection/membership set).
 */

export interface ColumnRotationResult {
  readonly column: string;
  readonly rotated: number;
}

export interface OrgRotationResult {
  readonly orgId: string;
  readonly columns: ColumnRotationResult[];
}

/**
 * Loose structural view of Inngest's `step.run` (see connector-index's
 * StepLike): the Inngest wrapper passes the real step so each rotation batch
 * becomes a durable checkpoint; direct callers (tests, scripts) default to an
 * inline runner with identical behavior.
 */
export type StepRunner = (id: string, fn: () => Promise<unknown>) => Promise<unknown>;

const inlineStep: StepRunner = (_id, fn) => fn();

/**
 * Re-encrypt one org-scoped column whose rows are already at KMS_ESDK: read the
 * current ciphertext, decrypt under the org key, re-encrypt under a fresh data
 * key, write back. Pages by primary key so a large table rotates in bounded
 * batches; each page runs inside a step so a retry resumes from the last
 * completed page instead of row 0. ONLY rows for this org are touched (org_id
 * filter).
 */
async function rotateColumn(
  service: SupabaseClient,
  orgId: string,
  opts: {
    table: string;
    pk: string;
    encColumn: string;
    versionColumn: string;
    batchSize: number;
    runStep: StepRunner;
  },
): Promise<ColumnRotationResult> {
  const { table, pk, encColumn, versionColumn, batchSize, runStep } = opts;
  let rotated = 0;
  let cursor: string | number | null = null;

  for (let page = 0; ; page += 1) {
    const pageCursor = cursor;
    const result = (await runStep(`rotate-${table}-${encColumn}-${String(page)}`, async () => {
      let query = service
        .from(table)
        .select(`${pk}, ${encColumn}`)
        .eq('org_id', orgId)
        .eq(versionColumn, CRYPTO_VERSION.KMS_ESDK)
        .not(encColumn, 'is', null)
        .order(pk, { ascending: true })
        .limit(batchSize);
      if (pageCursor !== null) query = query.gt(pk, pageCursor);

      const { data, error } = await query;
      if (error !== null) {
        throw new Error(`U12 rotate read ${table}.${encColumn} failed: ${error.message}`);
      }
      const rows = (data ?? []) as unknown as Record<string, unknown>[];

      let pageRotated = 0;
      let lastId: string | number | null = pageCursor;
      for (const row of rows) {
        const id = row[pk] as string | number;
        const enc = row[encColumn] as string;
        const plaintext = await decryptForOrgFromBytea(orgId, enc);
        const reEnc = await encryptForOrgToBytea(orgId, plaintext);
        // Optimistic-concurrency guard (mirrors the atlassian path): only write
        // if the ciphertext is unchanged since we read it, so a concurrent
        // write isn't clobbered with re-encrypted STALE plaintext.
        const { data: upData, error: upErr } = await service
          .from(table)
          .update({ [encColumn]: reEnc })
          .eq(pk, id)
          .eq('org_id', orgId)
          .eq(encColumn, enc)
          .select(pk);
        if (upErr !== null) {
          throw new Error(`U12 rotate write ${table}.${pk}=${String(id)} failed: ${upErr.message}`);
        }
        if (Array.isArray(upData) && upData.length > 0) {
          pageRotated += 1;
        } else {
          console.warn(
            `U12 rotate skipped ${table}.${pk}=${String(id)} (org=${orgId}): row changed concurrently; the fresher write wins`,
          );
        }
        lastId = id;
      }
      return { rotated: pageRotated, cursor: lastId, done: rows.length < batchSize };
    })) as { rotated: number; cursor: string | number | null; done: boolean };

    rotated += result.rotated;
    cursor = result.cursor;
    if (result.done) break;
  }

  return { column: `${table}.${encColumn}`, rotated };
}

/** Re-encrypt the org's atlassian connection tokens (access + refresh). */
async function rotateAtlassian(
  service: SupabaseClient,
  orgId: string,
): Promise<ColumnRotationResult> {
  let rotated = 0;
  const { data, error } = await service
    .from('atlassian_connections')
    .select('id, access_token_enc, refresh_token_enc, token_version')
    .eq('org_id', orgId);
  if (error !== null) {
    throw new Error(`U12 rotate read atlassian_connections failed: ${error.message}`);
  }
  const rows = (data ?? []) as {
    id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    token_version: number;
  }[];
  for (const row of rows) {
    if (row.access_token_enc === null || row.refresh_token_enc === null) continue;
    const [access, refresh] = await Promise.all([
      decryptForOrgFromBytea(orgId, row.access_token_enc),
      decryptForOrgFromBytea(orgId, row.refresh_token_enc),
    ]);
    const [accessEnc, refreshEnc] = await Promise.all([
      encryptForOrgToBytea(orgId, access),
      encryptForOrgToBytea(orgId, refresh),
    ]);
    // Optimistic-concurrency guard: a concurrent token refresh increments
    // token_version + rewrites the ciphertext; only write if unchanged so we
    // don't clobber a fresher rotation with our stale re-encrypted bytes.
    const { data: upData, error: upErr } = await service
      .from('atlassian_connections')
      .update({ access_token_enc: accessEnc, refresh_token_enc: refreshEnc })
      .eq('id', row.id)
      .eq('org_id', orgId)
      .eq('token_version', row.token_version)
      .select('id');
    if (upErr !== null) {
      throw new Error(`U12 rotate atlassian write ${row.id} failed: ${upErr.message}`);
    }
    if (Array.isArray(upData) && upData.length > 0) {
      rotated += 1;
    }
  }
  return { column: 'atlassian_connections.{access,refresh}_token_enc', rotated };
}

/** Re-encrypt Google refresh tokens whose key_org_id is this org. */
async function rotateGoogleTokens(
  service: SupabaseClient,
  orgId: string,
): Promise<ColumnRotationResult> {
  let rotated = 0;
  const { data, error } = await service
    .from('user_google_tokens')
    .select('user_id, refresh_token_enc')
    .eq('key_org_id', orgId)
    .eq('key_version', CRYPTO_VERSION.KMS_ESDK)
    .not('refresh_token_enc', 'is', null);
  if (error !== null) {
    throw new Error(`U12 rotate read user_google_tokens failed: ${error.message}`);
  }
  const rows = (data ?? []) as { user_id: string; refresh_token_enc: string }[];
  for (const row of rows) {
    const plaintext = await decryptForOrgFromBytea(orgId, row.refresh_token_enc);
    const reEnc = await encryptForOrgToBytea(orgId, plaintext);
    const { error: upErr } = await service
      .from('user_google_tokens')
      .update({ refresh_token_enc: reEnc })
      .eq('user_id', row.user_id)
      .eq('key_org_id', orgId);
    if (upErr !== null) {
      throw new Error(`U12 rotate google write ${row.user_id} failed: ${upErr.message}`);
    }
    rotated += 1;
  }
  return { column: 'user_google_tokens.refresh_token_enc', rotated };
}

/**
 * Rotate every encrypted column for a SINGLE org under a fresh data key. Scoped
 * strictly to the target org — other orgs are never read or written. Returns
 * per-column counts.
 */
export async function rotateOrgKey(
  service: SupabaseClient,
  orgId: string,
  opts: { batchSize?: number; runStep?: StepRunner } = {},
): Promise<OrgRotationResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const runStep = opts.runStep ?? inlineStep;
  const columns: ColumnRotationResult[] = [];

  for (const col of ENCRYPTED_COLUMNS) {
    columns.push(await rotateColumn(service, orgId, { ...col, batchSize, runStep }));
  }
  columns.push(
    (await runStep('rotate-atlassian_connections', () =>
      rotateAtlassian(service, orgId),
    )) as ColumnRotationResult,
  );
  columns.push(
    (await runStep('rotate-user_google_tokens', () =>
      rotateGoogleTokens(service, orgId),
    )) as ColumnRotationResult,
  );

  return { orgId, columns };
}

/**
 * Mark an org's key as revoked in the operational record. This is the DB-side
 * half of instant revocation; the cryptographic half is disabling the org's CMK
 * in AWS KMS, after which every decrypt for the org throws (data unreadable
 * until the CMK is re-enabled). Scoped to one org's row.
 */
export async function disableOrgKey(service: SupabaseClient, orgId: string): Promise<void> {
  const { error } = await service
    .from('org_encryption_keys')
    .update({ status: 'revoked' })
    .eq('org_id', orgId);
  if (error !== null) {
    throw new Error(`U12 disableOrgKey failed for org ${orgId}: ${error.message}`);
  }
}

/**
 * Inngest wrapper: rotate (or revoke) a single org's key. Triggered manually
 * (`risezome/encryption.rotate-org-key`) by an operator. `mode: 'revoke'` marks
 * the org-key record revoked (pair with disabling the CMK in KMS); the default
 * mode re-encrypts the org's rows under a fresh data key.
 */
export const rotateOrgKeyFn = inngest.createFunction(
  {
    id: 'rotate-org-key',
    name: 'Per-org key rotation / revocation',
    retries: 3,
    triggers: [{ event: 'risezome/encryption.rotate-org-key' }],
  },
  async ({ event, step }) => {
    const data =
      (
        event as unknown as {
          data?: { orgId?: string; mode?: 'rotate' | 'revoke'; batchSize?: number };
        }
      ).data ?? {};
    if (data.orgId === undefined) {
      throw new Error('rotate-org-key requires data.orgId');
    }
    const service = createServiceRoleClient();
    if (data.mode === 'revoke') {
      await disableOrgKey(service, data.orgId);
      return { orgId: data.orgId, revoked: true };
    }
    // Each (table, column, page) batch checkpoints via step.run so a large
    // org's rotation resumes from the last completed batch on retry.
    const runStep: StepRunner = (id, fn) => step.run(id, fn);
    return rotateOrgKey(service, data.orgId, {
      runStep,
      ...(data.batchSize !== undefined && { batchSize: data.batchSize }),
    });
  },
);
