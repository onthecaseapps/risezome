import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  KMSClient,
  NotFoundException,
} from '@aws-sdk/client-kms';
import { aliasForOrg } from '@risezome/crypto';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Per-org KMS CMK provisioning (security plan 003, U8; KTD2).
 *
 * Ensures an org has a per-org Customer Master Key + deterministic alias
 * (`aliasForOrg(orgId)` → `alias/<prefix>-org-<orgId>`) and records it in
 * `org_encryption_keys`. Idempotent: the alias is deterministic, so re-running
 * for an already-provisioned org is a no-op (describe-if-exists short-circuits
 * key creation, and the upsert is keyed on org_id). This lets U11 call it
 * lazily for existing orgs during the migration, and the org-creation hook call
 * it eagerly for new orgs.
 *
 * Dev/CI: when `RISEZOME_DEV_CRYPTO_KEY` is set, @risezome/crypto uses a local
 * RawAES per-org keyring with no AWS CMK, so provisioning is a pure DB record —
 * we early-return after upserting `status='active'`, `kms_alias=aliasForOrg`,
 * `kms_key_arn=null`. Production (key unset) hits the real KMS path below.
 *
 * AWS-gated: the KMS calls cannot be exercised in this repo's local/CI env;
 * they are typed and structured to be correct, and run on deploy.
 */

export interface ProvisionResult {
  orgId: string;
  kmsAlias: string;
  kmsKeyArn: string | null;
  created: boolean;
  devFallback: boolean;
}

function isDevFallback(): boolean {
  const k = process.env.RISEZOME_DEV_CRYPTO_KEY;
  return k !== undefined && k.length > 0;
}

/**
 * Ensure the org's CMK + alias exist in KMS and the `org_encryption_keys` record
 * is present. Pure function over an injected Supabase client + (optional) KMS
 * client so it is unit-testable; the Inngest wrapper supplies the real clients.
 */
export async function provisionOrgKey(
  orgId: string,
  service: SupabaseClient,
  kms?: KMSClient,
): Promise<ProvisionResult> {
  const kmsAlias = aliasForOrg(orgId);

  // Dev/CI: no AWS CMK; record the provisioning row and stop.
  if (isDevFallback()) {
    await upsertKeyRow(service, orgId, { kms_alias: kmsAlias, kms_key_arn: null });
    return { orgId, kmsAlias, kmsKeyArn: null, created: false, devFallback: true };
  }

  const client = kms ?? new KMSClient({});

  // Idempotency: the alias is deterministic, so a prior provisioning already
  // points it at the org's CMK. Describe-if-exists short-circuits key creation.
  let kmsKeyArn: string | null = null;
  let created = false;
  try {
    const described = await client.send(new DescribeKeyCommand({ KeyId: kmsAlias }));
    kmsKeyArn = described.KeyMetadata?.Arn ?? null;
  } catch (err) {
    if (!(err instanceof NotFoundException)) throw err;
    // No CMK behind this alias yet → create the key, then bind the alias to it.
    const createdKey = await client.send(
      new CreateKeyCommand({
        Description: `Risezome per-org envelope CMK for org ${orgId}`,
        KeyUsage: 'ENCRYPT_DECRYPT',
        // Symmetric default spec; the AWS Encryption SDK GenerateDataKey/Decrypt
        // flow uses it as a wrapping key.
        Tags: [{ TagKey: 'risezome:org_id', TagValue: orgId }],
      }),
    );
    kmsKeyArn = createdKey.KeyMetadata?.Arn ?? null;
    const keyId = createdKey.KeyMetadata?.KeyId;
    if (keyId === undefined) throw new Error(`KMS CreateKey returned no KeyId for org ${orgId}`);
    await client.send(new CreateAliasCommand({ AliasName: kmsAlias, TargetKeyId: keyId }));
    created = true;
  }

  await upsertKeyRow(service, orgId, { kms_alias: kmsAlias, kms_key_arn: kmsKeyArn });
  return { orgId, kmsAlias, kmsKeyArn, created, devFallback: false };
}

async function upsertKeyRow(
  service: SupabaseClient,
  orgId: string,
  refs: { kms_alias: string; kms_key_arn: string | null },
): Promise<void> {
  const { error } = await service.from('org_encryption_keys').upsert(
    {
      org_id: orgId,
      kms_alias: refs.kms_alias,
      kms_key_arn: refs.kms_key_arn,
      status: 'active',
    },
    { onConflict: 'org_id' },
  );
  if (error !== null) {
    throw new Error(`org_encryption_keys upsert failed for org ${orgId}: ${error.message}`);
  }
}

/**
 * Inngest wrapper: provision a CMK when an org is created. Triggered by
 * `risezome/org.created` (sent from the org-creation server action). Idempotent
 * and safe to replay.
 */
export const provisionOrgKeyFn = inngest.createFunction(
  {
    id: 'provision-org-key',
    name: 'Provision a per-org KMS encryption key',
    retries: 3,
    triggers: [{ event: 'risezome/org.created' }],
  },
  async ({ event }) => {
    const { orgId } = (event as unknown as { data: { orgId: string } }).data;
    const service = createServiceRoleClient();
    return provisionOrgKey(orgId, service);
  },
);
