import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptForOrgFromBytea } from '@risezome/crypto';

/**
 * Transcript read helper (U10). The legacy pgcrypto wrappers
 * (`encryptToken`/`decryptToken`) and their `USER_TOKEN_ENCRYPTION_KEY` reader
 * were removed in security plan 003 U13 after the per-org KMS cutover; the only
 * remaining legacy-decrypt caller is the one-time U11 backfill
 * (`migrate-encryption-to-kms.ts`), which keeps its own scoped reference.
 *
 * `transcriptWithText` below was rewired off the `transcript_with_text` RPC onto
 * app-side per-org KMS batch decrypt (U10); it is the only export here.
 */

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
