import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Decrypt a pgcrypto-encrypted secret column (e.g. trello_connections.token_enc)
 * via the DB helper `public.decrypt_refresh_token` (OpenPGP/AES-256 — a vetted
 * library, never hand-rolled, per security KTD1). The symmetric key lives only
 * in USER_TOKEN_ENCRYPTION_KEY and is passed per call; it must match the value
 * the portal uses to encrypt.
 */
function requireTokenKey(): string {
  const key = process.env.USER_TOKEN_ENCRYPTION_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error('Missing required environment variable: USER_TOKEN_ENCRYPTION_KEY');
  }
  return key;
}

export async function decryptToken(db: SupabaseClient, ciphertext: string): Promise<string> {
  const { data, error } = (await db.rpc('decrypt_refresh_token', {
    ciphertext,
    key: requireTokenKey(),
  })) as { data: string | null; error: { message: string } | null };
  if (error !== null || data === null) {
    throw new Error(`decrypt_refresh_token failed: ${error?.message ?? 'returned null'}`);
  }
  return data;
}

/** Encrypt `plaintext` to a pgcrypto ciphertext (write straight into a bytea column). */
export async function encryptToken(db: SupabaseClient, plaintext: string): Promise<string> {
  const { data, error } = (await db.rpc('encrypt_refresh_token', {
    plaintext,
    key: requireTokenKey(),
  })) as { data: string | null; error: { message: string } | null };
  if (error !== null || data === null) {
    throw new Error(`encrypt_refresh_token failed: ${error?.message ?? 'returned null'}`);
  }
  return data;
}
