-- Query-time corpus filtering (U7): backfill visible_team_ids on the existing
-- corpus, so the query predicate (when enabled) preserves today's retrieval.
--
-- At cutover EVERY team's view_policy was backfilled from the source's policy
-- (20260613000000), so all teams selecting a source share one view — and every
-- doc already in the corpus passed that policy. Therefore each existing doc is
-- visible to ALL teams selecting its source: visible_team_ids = those team ids.
-- No per-doc glob/attribute evaluation is needed at cutover (it only matters once
-- a team EDITS its view, which triggers a reindex that recomputes per-doc).
--
-- Pure SQL join, idempotent (re-running re-derives from the current team set).
-- Chunks whose source has no team selection stay '{}' (invisible — but such a
-- source isn't in any meeting's effective set anyway).

with src_teams as (
  select ts.source_id, array_agg(ts.team_id::text) as team_ids
  from public.team_sources ts
  group by ts.source_id
)
update public.doc_chunks dc
  set visible_team_ids = st.team_ids
  from src_teams st
  where dc.source_id = st.source_id;

with src_teams as (
  select ts.source_id, array_agg(ts.team_id::text) as team_ids
  from public.team_sources ts
  group by ts.source_id
)
update public.corpus_chunk_embeddings c
  set visible_team_ids = st.team_ids
  from src_teams st
  where c.source_id = st.source_id;
