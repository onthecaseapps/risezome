/**
 * Shared descriptor list of the org-scoped, version-marked encrypted columns
 * (security plan 003). Both the one-time pgcrypto→KMS backfill
 * (`migrate-encryption-to-kms.ts`) and per-org rotation (`rotate-org-key.ts`)
 * walk exactly these columns the same way, so the list lives here once to keep
 * the two in lockstep — adding a new encrypted column means editing one place.
 *
 * Atlassian (`atlassian_connections`) and Google (`user_google_tokens`) are
 * special-cased in both callers (probe-based / per-user keying) and are
 * deliberately NOT in this list.
 */

/** One org-scoped, version-marked encrypted column. */
export interface EncryptedColumn {
  /** Table holding the encrypted column. */
  readonly table: string;
  /** Primary-key column used to address a single row. */
  readonly pk: string;
  /** The `bytea` column holding the ciphertext. */
  readonly encColumn: string;
  /** The `*_version` sentinel column (CRYPTO_VERSION). */
  readonly versionColumn: string;
}

/**
 * The org-scoped, version-marked encrypted columns, in a stable order. Shared by
 * the backfill and rotation jobs.
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    table: 'meetings',
    pk: 'meeting_id',
    encColumn: 'recap_text_enc',
    versionColumn: 'recap_key_version',
  },
  {
    table: 'meetings',
    pk: 'meeting_id',
    encColumn: 'recap_json_enc',
    versionColumn: 'recap_json_key_version',
  },
  {
    table: 'syntheses',
    pk: 'synthesis_id',
    encColumn: 'accumulated_text_enc',
    versionColumn: 'synth_key_version',
  },
  {
    table: 'meeting_events',
    pk: 'event_id',
    encColumn: 'transcript_text_enc',
    versionColumn: 'transcript_key_version',
  },
  {
    table: 'trello_connections',
    pk: 'org_id',
    encColumn: 'token_enc',
    versionColumn: 'token_version',
  },
];

/** Default batch size for paging encrypted rows; bounded so a pass is cheap. */
export const DEFAULT_BATCH_SIZE = 200;
