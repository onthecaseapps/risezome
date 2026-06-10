/**
 * Org-scoped corpus document IDs.
 *
 * `docs.id` (and the chunk IDs derived from it) is a single global text PK. The
 * external-identity portion alone (e.g. `github:owner/repo:path@sha`,
 * `trello:board:card`) is NOT unique across tenants: two orgs that connect the
 * SAME external resource produce the same ID and collide on the PK — which is a
 * cross-tenant hazard (the second org's upsert would overwrite the first's row,
 * or, with the forbid_org_move guard, hard-fail a legitimate scenario).
 *
 * Every doc ID is therefore prefixed with the owning org's UUID, so the same
 * external resource lives under a distinct ID per org and the two never touch.
 * IDs are treated as OPAQUE everywhere (nothing parses them), so the prefix is
 * transparent to the rest of the system; chunk IDs are built from the doc ID
 * (`{docId}::{pos}` / `{docId}#chunk:{pos}`) so they inherit the prefix for free.
 *
 * Format: `{orgId}:{externalId}`. Must match the in-place rename in migration
 * 20260612040000_org_scoped_doc_ids.sql (`org_id::text || ':' || id`).
 */
export function orgScopedDocId(orgId: string, externalId: string): string {
  return `${orgId}:${externalId}`;
}
