-- Security hardening (review findings F3 + F4). Two small, behavior-preserving
-- tightenings — no access semantics change.

------------------------------------------------------------
-- F3: set_updated_at() was the ONE function in the schema without a pinned
-- search_path. It runs as invoker and its body only touches new.updated_at, so
-- the blast radius was minimal — pinned for consistency with everything else.
------------------------------------------------------------
create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
  as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

------------------------------------------------------------
-- F4: the realtime broadcast policy cast an attacker-controlled topic segment
-- straight to uuid — `meeting:<org>:<not-a-uuid>` made `::uuid` RAISE inside
-- policy evaluation. Not a data leak (the error denies the row), but a crafted
-- subscribe shouldn't be able to throw inside RLS at all. Guard the segment
-- shape first so a malformed topic deterministically DENIES instead of erroring.
------------------------------------------------------------
drop policy if exists "members access their meeting broadcasts by privacy" on realtime.messages;
create policy "members access their meeting broadcasts by privacy"
  on realtime.messages for select
  to authenticated
  using (
    extension = 'broadcast'
    and topic like 'meeting:%'
    -- Shape-check the meetingId segment BEFORE casting: a non-uuid third
    -- segment fails the regex (false) rather than raising on ::uuid.
    and split_part(topic, ':', 3) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and public.can_access_meeting(split_part(topic, ':', 3)::uuid)
  );

------------------------------------------------------------
-- F1: meeting_effective_source_ids is SECURITY DEFINER (bypasses RLS) and was
-- granted to `authenticated` with NO caller-access check — any authenticated
-- user who learns a meeting UUID could enumerate that meeting's source-id set
-- (a cross-tenant metadata oracle). Only the bot-worker (service role) calls
-- it; revoke the unused authenticated grant entirely.
------------------------------------------------------------
revoke execute on function public.meeting_effective_source_ids(uuid) from authenticated;

------------------------------------------------------------
-- F3: the SECURITY INVOKER search/stats RPCs grant to `authenticated` but never
-- revoked the default PUBLIC/anon EXECUTE. RLS still returns zero rows to anon
-- (no data leak), but anonymous callers shouldn't be able to invoke org-
-- parameterized search machinery at all. Lock them to authenticated/service.
------------------------------------------------------------
revoke execute on function public.search_corpus_vector(uuid, text, int, uuid[]) from public, anon;
revoke execute on function public.search_corpus_fts(uuid, text, int, uuid[]) from public, anon;
revoke execute on function public.capture_card_stats(uuid[]) from public, anon;
revoke execute on function public.knowledge_gaps_stats(text[]) from public, anon;

------------------------------------------------------------
-- F4: pin search_path on the two functions that still lacked it (SECURITY
-- INVOKER + fully schema-qualified, so not an escalation vector — consistency
-- + defense-in-depth). create-or-replace preserves their existing ACLs.
------------------------------------------------------------
alter function public.search_corpus_vector(uuid, text, int, uuid[]) set search_path = pg_catalog, public;
alter function public.search_corpus_fts(uuid, text, int, uuid[]) set search_path = pg_catalog, public;
alter function public.enforce_last_manager() set search_path = pg_catalog, public;
