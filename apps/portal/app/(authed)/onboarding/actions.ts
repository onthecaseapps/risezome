'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CURRENT_ORG_COOKIE, requireAuthedUser } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Create a new org with the current user as its initial Super Admin (the
 * master-key holder, R15 — seeded at creation so one always exists). Used by both
 * the onboarding form (first-time sign-in) and the secondary "+ Create new
 * org" form on /orgs/new.
 *
 * Service-role client because we're inserting into both orgs and
 * org_members within the same transaction-ish window (Supabase JS client
 * doesn't expose pg transactions; we accept the brief window of an org
 * existing without any members if the second insert fails, and we catch
 * that by deleting the org on failure).
 *
 * Sets the current_org_id cookie to the new org and redirects to /sources.
 * Returning a Promise<void> matches the form action contract.
 */
export async function createOrg(formData: FormData): Promise<void> {
  const user = await requireAuthedUser();

  const raw = formData.get('name');
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0) {
    // Form-side validation should catch this; this is defense in depth.
    redirect('/onboarding?error=empty_name');
  }
  if (name.length > 100) {
    redirect('/onboarding?error=name_too_long');
  }

  const service = createServiceRoleClient();

  const { data: orgRow, error: orgErr } = await service
    .from('orgs')
    .insert({ name })
    .select('id')
    .single();
  if (orgErr !== null || orgRow === null) {
     
    console.error('[onboarding.createOrg] orgs insert failed:', orgErr);
    redirect('/onboarding?error=create_failed');
  }

  const orgId = orgRow.id as string;
  const { error: memberErr } = await service
    .from('org_members')
    .insert({ org_id: orgId, user_id: user.id, role: 'super_admin' });
  if (memberErr !== null) {
    // Compensating delete to avoid an orphan org without a manager.
    await service.from('orgs').delete().eq('id', orgId);

    console.error('[onboarding.createOrg] org_members insert failed:', memberErr);
    redirect('/onboarding?error=create_failed');
  }

  // Seed the first team ("General") + add the creator (A-R14). The U1 default-team
  // backfill only covers orgs that existed at migration time; NEW orgs created via
  // onboarding need a team here so they're never team-less (the team switcher,
  // browse lens, and source curation all assume ≥1 team). Mirrors the backfill's
  // shape (name 'General', slug 'general'). The team is the unit sources attach to
  // in U3, so it must exist before the admin reaches /sources.
  const { data: teamRow, error: teamErr } = await service
    .from('teams')
    .insert({ org_id: orgId, name: 'General', slug: 'general' })
    .select('team_id')
    .single();
  if (teamErr !== null || teamRow === null) {
    // Compensating cleanup: org_members cascades on org delete, so dropping the
    // org leaves no orphans.
    await service.from('orgs').delete().eq('id', orgId);

    console.error('[onboarding.createOrg] teams insert failed:', teamErr);
    redirect('/onboarding?error=create_failed');
  }

  const { error: teamMemberErr } = await service
    .from('team_members')
    .insert({ team_id: teamRow.team_id as string, user_id: user.id });
  if (teamMemberErr !== null) {
    await service.from('orgs').delete().eq('id', orgId);

    console.error('[onboarding.createOrg] team_members insert failed:', teamMemberErr);
    redirect('/onboarding?error=create_failed');
  }

  // Provision the org's per-org KMS encryption key (security plan 003, U8).
  // Best-effort + idempotent: a failed kickoff must NOT block org creation —
  // provisioning is replayable (deterministic alias) and U11's lazy ensure-create
  // also covers any org that slipped through. Mirrors the calendar-sync soft-fail.
  try {
    const { inngest } = await import('../../../src/inngest/client');
    await inngest.send({ name: 'risezome/org.created', data: { orgId } });
  } catch (err) {
    console.error('[onboarding.createOrg] org-key provisioning kickoff failed:', err);
  }

  const cookieStore = await cookies();
  cookieStore.set(CURRENT_ORG_COOKIE, orgId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect('/sources');
}
