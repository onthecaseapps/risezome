// @vitest-environment node
/**
 * Unit tests for the per-org KMS provisioning orphan-guard (U8).
 *
 * AWS-gated in production, but the KMS calls are funneled through an injectable
 * KMSClient, so we drive the three branches with an in-memory fake client (no
 * AWS): a fresh org (DescribeKey NotFound → CreateKey → CreateAlias), an
 * already-provisioned org (DescribeKey succeeds → no create), and the
 * partial-retry case where the alias already exists (CreateAlias throws
 * AlreadyExistsException → adopt via re-describe, no duplicate key).
 */

import { describe, expect, it } from 'vitest';
import {
  AlreadyExistsException,
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  NotFoundException,
  type KMSClient,
} from '@aws-sdk/client-kms';
import type { SupabaseClient } from '@supabase/supabase-js';

// Provisioning must hit the REAL KMS branch, not the dev fallback.
delete process.env['RISEZOME_DEV_CRYPTO_KEY'];

const { provisionOrgKey } = await import('../../src/inngest/functions/provision-org-key');

/** Captures upsert payloads; always succeeds. */
function fakeService(): { client: SupabaseClient; upserts: unknown[] } {
  const upserts: unknown[] = [];
  const client = {
    from() {
      return {
        upsert(row: unknown) {
          upserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, upserts };
}

interface FakeKmsOpts {
  /** If set, DescribeKey(alias) returns this Arn; else throws NotFound. */
  existingArn?: string;
  /** If true, CreateAlias throws AlreadyExistsException (then re-describe wins). */
  aliasAlreadyExists?: boolean;
}

function fakeKms(opts: FakeKmsOpts): { client: KMSClient; calls: string[] } {
  const calls: string[] = [];
  let aliasBound = opts.existingArn !== undefined;
  const boundArn = opts.existingArn ?? 'arn:aws:kms:us-east-1:1:key/created-key-123';
  const client = {
    async send(cmd: unknown) {
      if (cmd instanceof DescribeKeyCommand) {
        calls.push('describe');
        if (aliasBound) return { KeyMetadata: { Arn: boundArn, KeyId: 'created-key-123' } };
        throw new NotFoundException({ message: 'not found', $metadata: {} });
      }
      if (cmd instanceof CreateKeyCommand) {
        calls.push('createKey');
        return { KeyMetadata: { Arn: boundArn, KeyId: 'created-key-123' } };
      }
      if (cmd instanceof CreateAliasCommand) {
        calls.push('createAlias');
        if (opts.aliasAlreadyExists) {
          aliasBound = true; // a prior partial run bound it
          throw new AlreadyExistsException({ message: 'exists', $metadata: {} });
        }
        aliasBound = true;
        return {};
      }
      throw new Error(`unexpected KMS command: ${String(cmd)}`);
    },
  } as unknown as KMSClient;
  return { client, calls };
}

describe('provisionOrgKey orphan-guard', () => {
  it('fresh org: DescribeKey NotFound → CreateKey → CreateAlias (created=true)', async () => {
    const { client: service, upserts } = fakeService();
    const { client: kms, calls } = fakeKms({});
    const res = await provisionOrgKey('org-fresh', service, kms);
    expect(res.created).toBe(true);
    expect(res.devFallback).toBe(false);
    expect(res.kmsKeyArn).toBe('arn:aws:kms:us-east-1:1:key/created-key-123');
    expect(calls).toEqual(['describe', 'createKey', 'createAlias']);
    expect(upserts).toHaveLength(1);
  });

  it('already provisioned: DescribeKey succeeds → no key/alias creation (created=false)', async () => {
    const { client: service } = fakeService();
    const { client: kms, calls } = fakeKms({
      existingArn: 'arn:aws:kms:us-east-1:1:key/existing-999',
    });
    const res = await provisionOrgKey('org-existing', service, kms);
    expect(res.created).toBe(false);
    expect(res.kmsKeyArn).toBe('arn:aws:kms:us-east-1:1:key/existing-999');
    expect(calls).toEqual(['describe']);
  });

  it('partial-retry: CreateAlias AlreadyExists → adopt via re-describe, no duplicate', async () => {
    const { client: service } = fakeService();
    const { client: kms, calls } = fakeKms({ aliasAlreadyExists: true });
    const res = await provisionOrgKey('org-retry', service, kms);
    // Created the key, alias create raced (already exists) → re-describe adopts it.
    expect(res.created).toBe(false);
    expect(res.kmsKeyArn).toBe('arn:aws:kms:us-east-1:1:key/created-key-123');
    // describe(NotFound) → createKey → createAlias(throws) → describe(adopt)
    expect(calls).toEqual(['describe', 'createKey', 'createAlias', 'describe']);
  });
});
