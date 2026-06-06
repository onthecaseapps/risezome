-- Carry an optional target team on a workspace invite (teams + members
-- consolidation). When set, the invite-accept flow adds the new member to this
-- team (a team_members row) right after they join the org — so a manager can
-- pre-assign a teammate to a team straight from the invite link.
--
-- Additive + nullable: existing invites (and any link where the manager skips
-- the team picker) keep team_id NULL and behave exactly as before. ON DELETE SET
-- NULL so archiving/deleting the team can never strand an outstanding invite;
-- the accept flow re-checks the team is live before inserting the membership.
--
-- No new RLS: org_invites stays service-role only (no client policies), same as
-- 20260603310000. The accept action (service-role) is the sole writer of the
-- team_members row this column drives.

alter table public.org_invites
  add column if not exists team_id uuid references public.teams(team_id) on delete set null;
