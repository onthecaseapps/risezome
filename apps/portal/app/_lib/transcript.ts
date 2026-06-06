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
  // Decrypt the first ciphertext-bearing row sequentially to WARM the per-org
  // decrypt-materials cache, then fan the rest out concurrently. A meeting's
  // utterances written within one data-key window share a wrapped data key, so a
  // cold Promise.all would race N concurrent KMS Decrypts for the same key (a
  // thundering herd that defeats the cache on first read); warming first collapses
  // them to ~1 KMS Decrypt + cache hits. Rows spanning multiple data-key windows
  // still herd within each later window, but that count is small (~one per window).
  const texts: (string | null)[] = new Array<string | null>(rows.length).fill(null);
  const decryptInto = async (i: number): Promise<void> => {
    const enc = rows[i]?.transcript_text_enc ?? null;
    if (enc !== null) texts[i] = await decryptForOrgFromBytea(orgId, enc);
  };
  const firstEnc = rows.findIndex((r) => r.transcript_text_enc !== null);
  if (firstEnc >= 0) await decryptInto(firstEnc);
  await Promise.all(rows.map((_, i) => (i === firstEnc ? Promise.resolve() : decryptInto(i))));
  return rows.map((r, i) => ({
    event_id: r.event_id,
    payload: r.payload,
    created_at: r.created_at,
    text: texts[i] ?? null,
  }));
}
