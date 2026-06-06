-- Structured meeting recap, encrypted at rest.
--
-- The legacy recap is a single encrypted markdown blob (meetings.recap_text_enc).
-- The structured recap stores a typed JSON object — overview, timestamped
-- topics, categorized decisions, action items (text + assignee + timestamp),
-- derived participants, and speaker count — encrypted under the org's per-org
-- KMS key (CRYPTO_VERSION.KMS_ESDK), stored as a bytea hex-text literal exactly
-- like recap_text_enc.
--
-- A NEW column (rather than overloading recap_text_enc) keeps backward-compat
-- trivial: old meetings keep recap_text_enc (markdown), recap_json_enc = null;
-- new meetings populate recap_json_enc. Additive + nullable — no backfill.
--
-- recap_json_key_version is the *_version sentinel for the per-org key rotation
-- (rotate-org-key.ts) + KMS backfill (migrate-encryption-to-kms.ts), which walk
-- the ENCRYPTED_COLUMNS registry in lockstep. The new column is registered there
-- (apps/portal/src/inngest/lib/encrypted-columns.ts) so rotation can't skip it.
--
-- No new RLS policy: recap_json_enc rides on the meetings row, which already has
-- the attendees-only SELECT policy (20260609030000_attendees_only_access.sql).
-- All recap writes are service-role (the Inngest generate-meeting-recap function).

alter table public.meetings
  add column recap_json_enc bytea,
  add column recap_json_key_version integer not null default 0;
