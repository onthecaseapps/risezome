-- U1 hotfix: the original org_members RLS policy was self-referential
-- (queried public.org_members from inside its own USING clause). This is
-- the classic Supabase RLS anti-pattern they explicitly warn against:
-- the subquery's RLS evaluation recurses into the outer policy and
-- returns nothing, so the user cannot read their own membership rows.
--
-- Symptom: listUserOrgs() returns empty even when org_members has rows
-- for the user, causing requireAuthedUserWithOrg() to bounce the user
-- back to /onboarding indefinitely after they create their first org.
--
-- Fix: replace with a direct `user_id = auth.uid()` check. The "see all
-- members of orgs you belong to" feature this was originally trying to
-- enable is deferred to a later unit and will use a SECURITY DEFINER
-- helper function to bypass the recursion concern when needed.

drop policy if exists "members read their org_members" on public.org_members;

create policy "user reads their own org_member rows"
  on public.org_members for select
  to authenticated
  using (user_id = (select auth.uid()));
