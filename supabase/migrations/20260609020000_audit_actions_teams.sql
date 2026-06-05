-- Extend permission_audit_log.action vocabulary for the teams restructure (U1).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U1; KTD7.
--
-- The teams restructure records new privileged events: team create/rename/archive
-- (team_change), team membership changes (team_membership_change), and gap-question
-- assignment (gap_assignment, U5). It also RETIRES the privacy ladder (U2), so
-- privacy_change / admin_override are no longer WRITTEN going forward.
--
-- ── DEVIATION FROM PLAN ("drop privacy_change/admin_override") ────────────────
-- permission_audit_log is APPEND-ONLY and immutable to clients (20260608040000).
-- The schema deployed to prod today may already hold historical privacy_change /
-- admin_override rows. Removing those values from the CHECK would reject the
-- existing rows (constraint re-validation fails) OR force deleting audit history,
-- which violates the append-only guarantee. So this CHANGE IS ADDITIVE: the old
-- values stay valid for HISTORY; the app simply stops writing them. The three new
-- actions are added. Net allowed set below.

alter table public.permission_audit_log
  drop constraint permission_audit_log_action_check;

alter table public.permission_audit_log
  add constraint permission_audit_log_action_check
  check (action in (
    -- retained for historical rows (no longer written after U2):
    'privacy_change',
    'admin_override',
    -- kept + still written:
    'role_change',
    'master_key_access',
    -- new (teams restructure):
    'team_change',
    'team_membership_change',
    'gap_assignment'
  ));
