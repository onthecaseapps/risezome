-- Encrypt synthesized answers at rest (security F1, follow-up to U9 / S9).
--
-- syntheses.accumulated_text holds the AI's grounded answer (what was asked +
-- quoted snippets from the customer's code/docs) — high-sensitivity content.
-- Unlike meeting_events.payload it is NOT queried with SQL operators, so it can
-- be column-encrypted directly (pgcrypto AES-256, KTD1). The value is written
-- once on the live synthesis 'done' transition (bot-worker); running rows have
-- no final text (NULL ciphertext).
--
-- Pre-launch: plaintext is not carried forward (any in-flight syntheses lose
-- their stored text and are regenerated on the next meeting).

alter table public.syntheses
  add column accumulated_text_enc bytea,
  add column synth_key_version    integer not null default 0;

alter table public.syntheses drop column accumulated_text;
