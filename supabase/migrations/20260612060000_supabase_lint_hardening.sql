-- Supabase Security Advisor cleanup (dashboard lints, 2026-06-10).
--
-- Four lint classes addressed:
--
--   1. function_search_path_mutable on search_corpus_vector / search_corpus_fts:
--      the flagged functions are the STALE 3-ARG OVERLOADS from
--      20260601100000. Later migrations "replaced" them with 4/5-arg
--      versions — but `create or replace` with a different signature
--      creates a SECOND function, so the originals lingered: unpinned,
--      granted to authenticated, and predating the source filter (the
--      3-arg vector search ignores p_source_ids entirely). Drop them.
--
--   2. anon/authenticated_security_definer_function_executable: Supabase
--      sets ALTER DEFAULT PRIVILEGES so every new function gets EXECUTE
--      granted DIRECTLY to anon + authenticated + service_role — which is
--      why earlier `revoke ... from public` statements (e.g. merge_gaps in
--      20260612030000) did not clear the lint: anon/authenticated hold
--      direct grants, not just the PUBLIC default. Revoke explicitly.
--        - RLS-policy predicates KEEP authenticated EXECUTE: policy
--          expressions evaluate as the querying role, which therefore
--          needs EXECUTE — revoking it would error every guarded query.
--          Only the anon grant is dropped (no policy targets anon).
--        - Service-only RPCs (gap assembly/merge, recount trigger fn) lose
--          both anon and authenticated.
--
--   3. extension_in_public: move pgvector to the `extensions` schema
--      (pgcrypto already lives there). Column types, indexes and opclasses
--      follow by OID; the only thing that breaks is `::vector` / `<=>`
--      resolution inside functions with a PINNED search_path, so the two
--      vector-using pinned functions get `extensions` appended.
--      NOTE for future migrations: unqualified `vector(...)` in NEW DDL
--      resolves via the role search_path (Supabase includes `extensions`);
--      qualify as `extensions.vector` if a migration pins its own path.
--
--   4. auth_leaked_password_protection is a dashboard toggle (Auth →
--      Passwords → leaked-password protection); not addressable in SQL.

------------------------------------------------------------
-- 1. Drop the stale 3-arg search RPC overloads.
------------------------------------------------------------
drop function if exists public.search_corpus_vector(uuid, text, int);
drop function if exists public.search_corpus_fts(uuid, text, int);

------------------------------------------------------------
-- 2a. RLS-policy predicates: anon must not execute; authenticated stays.
------------------------------------------------------------
revoke execute on function public.can_access_meeting(uuid) from public, anon;
revoke execute on function public.can_view_gap(text) from public, anon;
revoke execute on function public.can_view_gap_content(text) from public, anon;
revoke execute on function public.is_meeting_participant(uuid) from public, anon;
revoke execute on function public.is_org_admin(uuid) from public, anon;
revoke execute on function public.is_org_manager(uuid) from public, anon;
revoke execute on function public.is_super_admin(uuid) from public, anon;
revoke execute on function public.is_team_member(uuid) from public, anon;
revoke execute on function public.org_member_ids(uuid) from public, anon;

-- Self-scoped user RPC (reads only auth.uid()'s rows): authenticated keeps it.
revoke execute on function public.list_assigned_questions() from public, anon;

-- Bot-worker-only resolver (authenticated was already revoked in 20260612020000).
revoke execute on function public.meeting_effective_source_ids(uuid) from public, anon;

------------------------------------------------------------
-- 2b. Service-only RPCs: neither anon nor authenticated may call them.
--     All app callers go through service-role after their own authz checks
--     (requireManager for merge, Inngest jobs for assembly/recount).
------------------------------------------------------------
revoke execute on function public.assemble_gap_occurrence_group(uuid, uuid, text, text, double precision, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.assemble_gap_occurrence_group(uuid, uuid, text, text, double precision, jsonb, uuid[])
  to service_role;

revoke execute on function public.merge_gaps(uuid, text, text) from public, anon, authenticated;
grant execute on function public.merge_gaps(uuid, text, text) to service_role;

-- Trigger function: firing a trigger never checks the DML role's EXECUTE,
-- so this only removes the (pointless, lint-flagged) direct-call surface.
revoke execute on function public.gap_occurrences_recount() from public, anon, authenticated;

-- rls_auto_enable exists on hosted only (created outside migrations); guard
-- so a fresh local rebuild doesn't fail on the missing function.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

------------------------------------------------------------
-- 3. Move pgvector out of public.
------------------------------------------------------------
create schema if not exists extensions;
alter extension vector set schema extensions;

-- Re-pin the vector-using functions so `::vector` and `<=>` still resolve
-- under their pinned search_path.
alter function public.search_corpus_vector(uuid, text, int, uuid[], text)
  set search_path = pg_catalog, public, extensions;
alter function public.assemble_gap_occurrence_group(uuid, uuid, text, text, double precision, jsonb, uuid[])
  set search_path = pg_catalog, public, extensions;
