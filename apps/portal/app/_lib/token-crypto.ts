import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptForOrgFromBytea } from '@risezome/crypto';

/**
 * LEGACY pgcrypto wrappers (`encryptToken`/`decryptToken`). Superseded by the
 * per-org KMS envelope module (@risezome/crypto, `encryptForOrgToBytea` /
 * `decryptForOrgFromBytea`); no application code calls these anymore — they are
 * scheduled for removal in security plan 003 U13 (along with the SQL helpers).
 * Kept until the U11 re-encryption migration is verified.
 *
 * `transcriptWithText` below was rewired off the `transcript_with_text` RPC onto
 * app-side per-org KMS batch decrypt (U10); it is the only live export here.
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
 * Fetch a meeting's transcript with `text` decrypted (U10). Replaces the old
 * `transcript_with_text` RPC (which did pgcrypto decrypt server-side) with an
 * app-side batch decrypt: read the transcript rows (RLS on meeting_events still
 * gates them via the passed client) then `decryptForOrg` each. The per-org
 * caching CMM in @risezome/crypto collapses this to ~one KMS unwrap per org for
 * the whole meeting, so decrypting N rows is not N KMS calls. Same return shape
 * as before, so callers are unchanged.
 */
export async function transcriptWithText(
  db: SupabaseClient,
  meetingId: string,
  orgId: string,
): Promise<TranscriptRow[]> {
  const { data, error } = await db
    .from('meeting_events')
    .select('event_id, payload, created_at, transcript_text_enc')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .eq('type', 'transcript.data')
    .order('event_id', { ascending: true });
  if (error !== null) {
    throw new Error(`transcript read failed: ${error.message}`);
  }
  const rows = (data ?? []) as {
    event_id: number;
    payload: Record<string, unknown> | null;
    created_at: string;
    transcript_text_enc: string | null;
  }[];
  return Promise.all(
    rows.map(async (r) => ({
      event_id: r.event_id,
      payload: r.payload,
      created_at: r.created_at,
      text:
        r.transcript_text_enc !== null
          ? await decryptForOrgFromBytea(orgId, r.transcript_text_enc)
          : null,
    })),
  );
}
