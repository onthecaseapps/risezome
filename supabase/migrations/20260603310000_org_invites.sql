-- Shareable workspace-invite tokens (plan U2).
-- (Plan: docs/plans/2026-06-01-001-feat-workspace-invitations-roles-plan.md)
--
-- Structurally a sibling of pending_installations (20260531000000): an
-- unguessable single-use token bound to an org, redeemed-and-deleted to
-- prevent replay, with an explicit expiry. It differs in two ways:
--   * it carries the membership the link grants (role + can_invite_bot), and
--   * it is redeemed by a DIFFERENT user than the one who created it.
--
-- No RLS policies: service-role only. The invitee has no membership yet, so
-- the preview/accept flow reads this table through a service-role-backed
-- route/action, never user RLS. role/can_invite_bot are the source of truth
-- for the membership created at accept time — never trusted from client input.

create table public.org_invites (
  token          text        primary key,
  org_id         uuid        not null references public.orgs(id) on delete cascade,
  role           text        not null check (role in ('manager', 'member')),
  can_invite_bot boolean     not null default false,
  created_by     uuid        not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '7 days')
);

create index org_invites_org_id_idx     on public.org_invites (org_id);
create index org_invites_expires_at_idx on public.org_invites (expires_at);

alter table public.org_invites enable row level security;
-- No SELECT/INSERT/UPDATE/DELETE policies; only service-role can touch this table.
