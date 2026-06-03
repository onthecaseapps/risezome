-- U3 (plan 2026-06-03-003): close the unscoped-client-write surface.
--
-- The knowledge_gaps incident (docs/solutions/, user memory
-- rls-no-client-update-when-service-role-writes) showed that an authenticated
-- write policy which only re-asserts row ownership has NO column scoping — a
-- user can PATCH any column via PostgREST (publishable key + their JWT reach
-- PostgREST directly). Two of our authenticated write paths had exactly this
-- shape: `authenticated` held table-level UPDATE on every column, and RLS only
-- checked ownership. We restrict the writable columns with column-level GRANTs
-- (RLS continues to scope rows). A third table's client write policies were pure
-- redundant surface (all writes go through service-role) and are dropped.

-- ── calendar_events ──────────────────────────────────────────────────────────
-- Genuine client write path: opt-in-action.ts (createServerClient) toggles
-- bot_optin on the user's own event. The "users update bot_optin on their own
-- events" RLS policy scopes rows by user_id, but table-level UPDATE let a user
-- rewrite org_id (a cross-tenant move!), conference_url, title, etc. on their
-- own row. Restrict the authenticated role to the single intended column.
revoke update on public.calendar_events from authenticated;
grant update (bot_optin) on public.calendar_events to authenticated;

-- ── notifications ────────────────────────────────────────────────────────────
-- Genuine client write path: notification-actions.ts (createServerClient) marks
-- the user's own notification read. The "mark your own notifications read" RLS
-- policy scopes rows by user_id, but table-level UPDATE let a user rewrite
-- type/actor_id/org_id/gap_id on their own notification. Restrict to read_at.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ── knowledge_gap_sections ───────────────────────────────────────────────────
-- All writes flow through service-role server actions (section-actions.ts,
-- inngest/lib/knowledge-gaps.ts), which bypass RLS. The authenticated
-- INSERT/UPDATE/DELETE policies are therefore redundant attack surface (a
-- manager could PATCH arbitrary section columns directly via PostgREST). Drop
-- them; RLS default-deny then blocks all direct client writes while the
-- service-role action path is unaffected. SELECT policies are left in place.
drop policy if exists "managers insert gap sections" on public.knowledge_gap_sections;
drop policy if exists "managers update gap sections" on public.knowledge_gap_sections;
drop policy if exists "managers delete gap sections" on public.knowledge_gap_sections;

-- Note (workspace_bot_settings): its manager upsert (save-action.ts,
-- createServerClient + requireManager + is_org_manager RLS) is a genuine
-- authenticated write path and is intentionally left as-is. The actor is a
-- trusted org manager and the table is per-org config; column-restricting an
-- UPSERT would break the insert path. Tracked in the service-role inventory (U6).
