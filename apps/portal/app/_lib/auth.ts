import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createServerClient } from './supabase-server';

export const CURRENT_ORG_COOKIE = 'risezome.current_org_id';

/**
 * Returns the current Supabase user, or redirects to /sign-in if there is no
 * session. Use in Server Components and Server Actions on `(authed)` routes
 * that don't require an org context (e.g., onboarding).
 */
export async function requireAuthedUser(): Promise<User> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error !== null || data.user === null) {
    redirect('/sign-in');
  }
  return data.user;
}

/**
 * Returns the user's org memberships. Used by the topbar to render the org
 * switcher. Returns [] if the user has no memberships yet (pre-onboarding).
 */
export interface UserOrg {
  id: string;
  name: string;
  role: string;
  canInviteBot: boolean;
}

export async function listUserOrgs(): Promise<UserOrg[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('org_members')
    .select('role, can_invite_bot, org:orgs(id, name)')
    .order('joined_at', { ascending: true });
  if (error !== null || data === null) return [];
  const out: UserOrg[] = [];
  for (const row of data) {
    // The join surfaces `org` as either an object or array depending on FK
    // multiplicity in the inferred type; normalize to the single object case.
    const orgField = row.org as unknown as { id: string; name: string } | { id: string; name: string }[] | null;
    const org = Array.isArray(orgField) ? orgField[0] : orgField;
    if (org === null || org === undefined) continue;
    out.push({
      id: org.id,
      name: org.name,
      role: row.role as string,
      canInviteBot: (row.can_invite_bot as boolean | null) ?? false,
    });
  }
  return out;
}

/**
 * Returns the current user + the resolved current org_id. Redirects:
 *   - to /sign-in if no session
 *   - to /onboarding if signed in but no org membership yet
 *
 * Resolution rules for current_org_id:
 *   1. If the `risezome.current_org_id` cookie is set AND the user is a
 *      member of that org, use it.
 *   2. Otherwise, fall back to the first (oldest) membership.
 *   3. If there are no memberships, redirect to /onboarding.
 *
 * The fallback is silent — we don't clear the stale cookie here because
 * doing so requires writing cookies during a Server Component render
 * (illegal); the switcher's server action handles cleanup.
 */
export interface AuthedOrgContext {
  user: User;
  orgId: string;
  orgName: string;
  /** The user's role in the resolved org: 'manager' | 'member'. */
  role: string;
  /** Whether the user may launch the bot into their own meetings. Managers
   *  are implicitly allowed; for members this reflects the granted flag. */
  canInviteBot: boolean;
}

export async function requireAuthedUserWithOrg(): Promise<AuthedOrgContext> {
  const user = await requireAuthedUser();
  const orgs = await listUserOrgs();
  if (orgs.length === 0) {
    redirect('/onboarding');
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const fromCookie = cookieValue !== undefined ? orgs.find((o) => o.id === cookieValue) : undefined;
  const chosen = fromCookie ?? orgs[0]!;
  return {
    user,
    orgId: chosen.id,
    orgName: chosen.name,
    role: chosen.role,
    canInviteBot: chosen.role === 'manager' || chosen.canInviteBot,
  };
}

/**
 * Like {@link requireAuthedUserWithOrg}, but redirects non-managers away.
 * Use to gate manager-only pages and server actions (Sources, Settings,
 * member management). RLS is the real authorization boundary; this is the
 * app-layer defense-in-depth that also keeps members out of the UI.
 */
export async function requireManager(): Promise<AuthedOrgContext> {
  const ctx = await requireAuthedUserWithOrg();
  if (ctx.role !== 'manager') {
    redirect('/upcoming');
  }
  return ctx;
}
