-- Corpus reconciliation: per-doc content fingerprint.
--
-- `content_hash` lets the indexers detect changed-vs-unchanged items on
-- reindex so unchanged items are not re-embedded:
--   * GitHub files store the git blob SHA (already an exact content hash).
--   * Issues/PRs, Trello, Jira, Confluence store SHA-256 of the joined
--     chunk-input text (precise: changes only when embedded content does).
--
-- Nullable: existing rows backfill on their next reindex. A null hash is
-- treated as "changed" by the reconcile helper (re-index once to populate),
-- except the helper may skip when the docId already matches and content is
-- unchanged (see apps/portal/src/inngest/lib/corpus-reconcile.ts).
--
-- No index needed — the reconcile helper only reads content_hash for rows
-- already filtered by (source_id, type), and source_id is indexed.

alter table public.docs add column content_hash text;
