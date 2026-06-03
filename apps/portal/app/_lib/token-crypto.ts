import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Application-layer wrappers around the pgcrypto column-encryption helpers
 * (`public.encrypt_refresh_token` / `public.decrypt_refresh_token`, defined in
 * migration 20260530100000). Those wrap `pgp_sym_encrypt`/`pgp_sym_decrypt`
 * (OpenPGP symmetric, AES-256) — a vetted, industry-standard library; we never
 * implement crypto ourselves (security KTD1).
 *
 * The symmetric key lives only in `USER_TOKEN_ENCRYPTION_KEY` (env) and is passed
 * to the SQL helper per call — the DB never stores it, so a dump yields only
 * ciphertext. Reused for every encrypted-at-rest secret (Atlassian, Trello, …).
 */

function requireTokenKey(): string {
  const key = process.env['USER_TOKEN_ENCRYPTION_KEY'];
  if (key === undefined || key.length === 0) {
    throw new Error('Missing required environment variable: USER_TOKEN_ENCRYPTION_KEY');
  }
  return key;
}

/**
 * Encrypt `plaintext` to a pgcrypto ciphertext. The returned value is the bytea
 * ciphertext in the string form PostgREST uses; write it straight back into a
 * `bytea` column.
 */
export async function encryptToken(service: SupabaseClient, plaintext: string): Promise<string> {
  const { data, error } = await service.rpc('encrypt_refresh_token', {
    plaintext,
    key: requireTokenKey(),
  });
  if (error !== null || data === null || data === undefined) {
    throw new Error(`encrypt_refresh_token failed: ${error?.message ?? 'returned null'}`);
  }
  return data as unknown as string;
}

/** Decrypt a pgcrypto ciphertext (a `bytea` column read back as a string) to plaintext. */
export async function decryptToken(service: SupabaseClient, ciphertext: string): Promise<string> {
  const { data, error } = await service.rpc('decrypt_refresh_token', {
    ciphertext,
    key: requireTokenKey(),
  });
  if (error !== null || data === null || data === undefined) {
    throw new Error(`decrypt_refresh_token failed: ${error?.message ?? 'returned null'}`);
  }
  return data as string;
}

/** One transcript event with its text decrypted server-side (F2). */
export interface TranscriptRow {
  event_id: number;
  payload: Record<string, unknown> | null;
  created_at: string;
  text: string | null;
}

/**
 * Fetch a meeting's transcript with `text` decrypted in a single round-trip via
 * the `transcript_with_text` RPC (F2). RLS on meeting_events still gates the
 * rows; the encryption key stays server-side.
 */
export async function transcriptWithText(
  db: SupabaseClient,
  meetingId: string,
  orgId: string,
): Promise<TranscriptRow[]> {
  const { data, error } = await db.rpc('transcript_with_text', {
    p_meeting_id: meetingId,
    p_org_id: orgId,
    p_key: requireTokenKey(),
  });
  if (error !== null) {
    throw new Error(`transcript_with_text failed: ${error.message}`);
  }
  return (data ?? []) as TranscriptRow[];
}
