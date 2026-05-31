-- syntheses pin columns + service-role write convention (plan U5).
--
-- The pin is a synthesis-level affordance now (replaces the prior card-
-- level pin on the live page). The brainstorm reverses the original
-- synthesis-card-plan decision ("Synthesis is not pinnable; user pins
-- the underlying source card") on the basis of live-test evidence.
--
-- No RLS UPDATE policy added here (B3 from review). Postgres RLS is
-- row-level — a WITH CHECK can't restrict which columns the UPDATE
-- touches. Instead, writes go through the pinSynthesisAction server
-- action which uses createServiceRoleClient() (bypasses RLS) plus an
-- explicit .eq('org_id', orgId) filter. Same posture as pinCardAction.
-- Members already have SELECT on syntheses via the org-membership
-- policy from the artifacts migration; the pin column is visible to
-- them via that existing read path.

alter table public.syntheses
  add column if not exists pinned    boolean     not null default false,
  add column if not exists pinned_at timestamptz;
