-- Permission audit log + admin-override RPC (permissions overhaul U5 Part A + U4).
-- Plan: docs/plans/2026-06-04-004-feat-permissions-overhaul-plan.md — U4, U5; KTD5, KTD6, KTD7.
--
-- ── permission_audit_log — APPEND-ONLY, SUPER-ADMIN-READABLE ──────────────────
-- The immutable trail for every privileged permission event in an org:
--
--   privacy_change    — a meeting owner changed their meeting's privacy_level
--   admin_override    — an admin set a meeting's privacy below the org floor
--                       (or changed someone else's meeting) via the override RPC
--   role_change       — a member's org role was changed (incl. super_admin grant)
--   master_key_access — a super_admin VIEWED a meeting they were not otherwise
--                       entitled to (recorded at the app layer, KTD5)
--
-- WRITE MODEL (KTD6): this table has RLS enabled with a SELECT policy ONLY. There
-- is deliberately NO INSERT / UPDATE / DELETE policy for ANY client role, so:
--   * No authenticated/anon client can INSERT a forged audit row via PostgREST.
--   * No one can UPDATE or DELETE an existing row via PostgREST — the log is
--     IMMUTABLE / APPEND-ONLY to every client.
-- All legitimate writes flow through hardened, org-scoped, role-gated SERVICE-ROLE
-- server actions (privacy-action.ts, member-actions.ts) and the app-layer
-- master-key recorder (meeting-access.ts). The service role bypasses RLS, so the
-- absence of a write policy does not block it; it only blocks every client.
--
-- READ MODEL (Q4): only a super_admin of the org may SELECT its audit log
-- (is_super_admin(org_id)). Members and plain managers (Admins) cannot read it.
--
-- ── admin_override_meeting_privacy(p_meeting_id, p_level) — SELF-CHECKED RPC ───
-- supabase-js cannot issue `set local app.bypass_privacy_floor='on'` + the UPDATE
-- in the SAME transaction (the floor-bypass mechanism from 20260608020000 needs
-- both in one tx). So the admin-override write path (U4, R12) is a SECURITY
-- DEFINER function that does the set_config + UPDATE atomically. Because it is the
-- ONE privileged client-callable RPC that bypasses the floor, it SELF-CHECKS that
-- auth.uid() is an admin of the meeting's org (is_org_admin) INSIDE the function
-- and raises otherwise — a non-admin caller cannot use it even though it is
-- granted to `authenticated`. The plain OWNER privacy change does NOT use this RPC
-- (it is a floor-enforced service-role UPDATE in privacy-action.ts).

------------------------------------------------------------
-- 1. permission_audit_log table
------------------------------------------------------------

create table public.permission_audit_log (
  id                bigserial    primary key,
  org_id            uuid         not null references public.orgs(id) on delete cascade,
  actor_id          uuid         not null,
  action            text         not null
                                 check (action in (
                                   'privacy_change',
                                   'admin_override',
                                   'role_change',
                                   'master_key_access'
                                 )),
  target_meeting_id uuid,
  detail            jsonb,
  created_at        timestamptz  not null default now()
);

-- Super-admin audit views read their org's log newest-first.
create index permission_audit_log_org_created_idx
  on public.permission_audit_log (org_id, created_at desc);

alter table public.permission_audit_log enable row level security;

-- READ: only a super_admin of the org. NO write policy of any kind (append-only,
-- service-role-write-only; immutable to clients — see header).
create policy "super admins read their org's audit log"
  on public.permission_audit_log for select
  to authenticated
  using (public.is_super_admin(org_id));

------------------------------------------------------------
-- 2. admin_override_meeting_privacy(p_meeting_id, p_level) — self-checked
------------------------------------------------------------
-- Sets a meeting's privacy_level, BYPASSING the org floor (R12), atomically with
-- the transaction-local GUC that the floor trigger honours. SELF-CHECKS that the
-- caller is an admin of the meeting's org; raises insufficient_privilege if not.
-- The UPDATE is org-scoped (and meeting-scoped) so it can never touch another
-- org's row. Returns nothing; the caller (privacy-action.ts) reads back + audits.

create function public.admin_override_meeting_privacy(
  p_meeting_id uuid,
  p_level text
)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if p_level not in ('only_me', 'only_participants', 'only_teammates') then
    raise exception 'invalid privacy level %', p_level
      using errcode = 'check_violation';
  end if;

  -- Resolve the meeting's org (also tells us the meeting exists).
  select org_id into v_org_id
  from public.meetings
  where meeting_id = p_meeting_id;

  if v_org_id is null then
    raise exception 'meeting % not found', p_meeting_id
      using errcode = 'no_data_found';
  end if;

  -- SELF-CHECK: only an admin (manager OR super_admin) of THIS meeting's org may
  -- override. is_org_admin resolves auth.uid() from the request JWT.
  if not public.is_org_admin(v_org_id) then
    raise exception 'not authorized to override meeting privacy'
      using errcode = 'insufficient_privilege';
  end if;

  -- Floor-exempt write (KTD7/R12): the transaction-local GUC tells the floor
  -- trigger to allow a below-floor level. `set local` confines it to this tx.
  perform set_config('app.bypass_privacy_floor', 'on', true);

  update public.meetings
  set privacy_level = p_level
  where meeting_id = p_meeting_id
    and org_id = v_org_id;
end;
$$;

-- Revoke from public; only authenticated may call (the function self-checks admin
-- inside, so granting to authenticated is safe — a non-admin call raises).
revoke all on function public.admin_override_meeting_privacy(uuid, text) from public;
grant execute on function public.admin_override_meeting_privacy(uuid, text) to authenticated;
