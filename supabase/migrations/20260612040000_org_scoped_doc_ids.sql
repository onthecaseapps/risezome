-- Org-scope corpus document + chunk IDs (root-cause fix for the cross-tenant
-- PK-collision class that forbid_org_move only backstopped).
--
-- docs.id and the chunk IDs derived from it are global text PKs whose
-- external-identity portion (`github:owner/repo:path@sha`, `trello:board:card`,
-- …) is NOT unique across tenants — two orgs connecting the same external
-- resource collided on the PK. From now on every ID is prefixed with the owning
-- org's UUID (see apps/portal/app/_lib/doc-id.ts `orgScopedDocId`); this
-- migration renames the EXISTING rows in place to the same `{org_id}:{id}` form.
--
-- IDs are opaque everywhere (nothing parses them) and chunk IDs embed the doc
-- ID, so the rename is transparent — we just rewrite the stored strings:
--   docs.id                         → `{org}:{id}`
--   doc_chunks.doc_id               (FK; follows docs.id via ON UPDATE CASCADE)
--   doc_chunks.chunk_id             → `{org}:{chunk_id}` (the embedded doc-id prefix)
--   corpus_chunk_embeddings.chunk_id (FK; follows doc_chunks.chunk_id via cascade)
--
-- cards.doc_id is a denormalized snapshot (no FK; the review/live pages render
-- from the card's own title/snippet/body, never a join to docs), so existing
-- cards keep their old-format doc_id harmlessly; new cards carry the new format.
--
-- Each migration runs in one transaction, so the cascades complete between
-- statements. The `not like (org_id::text || ':%')` guards make it idempotent
-- (re-run is a no-op) and safe on an empty corpus (0 rows touched).

-- 1. The doc_id / chunk_id FKs must follow a PK rename. The source_id FKs added
--    later are untouched (they don't reference these columns).
alter table public.doc_chunks
  drop constraint doc_chunks_doc_id_fkey,
  add constraint doc_chunks_doc_id_fkey
    foreign key (doc_id) references public.docs(id) on update cascade on delete cascade;

alter table public.corpus_chunk_embeddings
  drop constraint corpus_chunk_embeddings_chunk_id_fkey,
  add constraint corpus_chunk_embeddings_chunk_id_fkey
    foreign key (chunk_id) references public.doc_chunks(chunk_id) on update cascade on delete cascade;

-- 2. Rename doc IDs (doc_chunks.doc_id follows via the cascade above).
update public.docs
set id = org_id::text || ':' || id
where id not like (org_id::text || ':%');

-- 3. Rename chunk-id PKs (corpus_chunk_embeddings.chunk_id follows via cascade).
--    doc_chunks.doc_id was already updated by step 2's cascade, so after this
--    chunk_id = `{org}:{olddoc}::{pos}` and doc_id = `{org}:{olddoc}` — i.e.
--    chunk_id still startswith doc_id, matching the live `{docId}::{pos}` shape.
update public.doc_chunks
set chunk_id = org_id::text || ':' || chunk_id
where chunk_id not like (org_id::text || ':%');
