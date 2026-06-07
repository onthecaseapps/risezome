import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from './supabase-server';
import { isAdminRole } from './roles';

export const CURRENT_ORG_COOKIE = 'risezome.current_org_id';

/**
 * The authenticated identity we surface to the app. A trimmed projection of the
 * Supabase user — the only fields any caller reads (id everywhere; email +
 * full_name in the top-bar). Sourced from the verified JWT claims (no
 * Auth-server round-trip), so we deliberately do NOT expose the full `User`.
 */
export interface AuthedUser {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown>;
}

/**
 * Selected team for the browse "lens" (set by the top-bar team switcher).
 * Scopes which team's source/meeting context Captures/Knowledge browse against.
 * Absent (or 'all') means the "My meetings" view: attended meetings across any
 * team. The lens filters what you browse; it never grants access (U2).
 */
export const CURRENT_TEAM_COOKIE = 'risezome.current_team_id';

/**
 * Returns the current authenticated identity, or redirects to /sign-in if there
 * is no valid session. Use in Server Components and Server Actions on `(authed)`
 * routes that don't require an org context (e.g., onboarding).
 *
 * Uses `getClaims()` — which verifies the JWT locally against the project's
 * signing keys (no Auth-server round-trip when asymmetric keys are in use, and
 * never slower than `getUser()` otherwise). The middleware's per-request
 * `getUser()` already handles session refresh, so verifying the (now-fresh)
 * cookie's claims here is sufficient and cheap.
 *
 * Wrapped in React `cache()`: the layout (top bar), sidebar, and the page each
 * need the identity, so this dedupes them to a single verification per request.
 */
export const requireAuthedUser = cache(async (): Promise<AuthedUser> => {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error !== null || data === null) {
    redirect('/sign-in');
  }
  const claims = data.claims;
  return {
    id: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    user_metadata: (claims.user_metadata ?? {}) as Record<string, unknown>,
  };
});

/**
 * Returns the user's org memberships. Used by the topbar to render the org
 * switcher. Returns [] if the user has no memberships yet (pre-onboarding).
 */
/** A user's role within an org. Stored `manager` is the "Admin" tier (KTD1);
 *  `super_admin` inherits all admin powers plus the audited master key. */
export type OrgRole = 'member' | 'manager' | 'super_admin';

export interface UserOrg {
  id: string;
  name: string;
  role: OrgRole;
  canInviteBot: boolean;
}

export const listUserOrgs = cache(async (): Promise<UserOrg[]> => {
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
      role: row.role as OrgRole,
      canInviteBot: (row.can_invite_bot as boolean | null) ?? false,
    });
  }
  return out;
});

/** A team the current user belongs to, within a single org. */
export interface UserTeam {
  id: string;
  name: string;
  slug: string;
}

/**
 * Returns the current user's teams within `orgId`. Used by the top-bar team
 * switcher to render the browse-lens dropdown. Reads `team_members` joined to
 * `teams`, scoped to the org and excluding archived teams.
 *
 * Filters explicitly by `user_id`: the `team_members` SELECT policy is
 * org-scoped (a member may read ANY team's roster in their org so member-pickers
 * render), so RLS alone would surface every team in the org, not the caller's.
 * We dedupe defensively too — though a user has at most one row per team, the
 * org-scoped join can return co-member rows if the filter is ever loosened.
 * Returns [] on error or when the user is on no teams in this org. Mirrors
 * {@link listUserOrgs}.
 */
export const listUserTeams = cache(async (orgId: string): Promise<UserTeam[]> => {
  const supabase = await createServerClient();
  // The caller's id comes from the cached identity (one verification per
  // request) rather than its own Auth round-trip.
  const { id: userId } = await requireAuthedUser();
  const { data, error } = await supabase
    .from('team_members')
    .select('team:teams(team_id, name, slug, org_id, archived_at)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error !== null || data === null) return [];
  const seen = new Set<string>();
  const out: UserTeam[] = [];
  for (const row of data) {
    // The join surfaces `team` as either an object or array depending on FK
    // multiplicity in the inferred type; normalize to the single object case.
    const teamField = row.team as unknown as
      | { team_id: string; name: string; slug: string; org_id: string; archived_at: string | null }
      | { team_id: string; name: string; slug: string; org_id: string; archived_at: string | null }[]
      | null;
    const team = Array.isArray(teamField) ? teamField[0] : teamField;
    if (team === null || team === undefined) continue;
    if (team.org_id !== orgId) continue;
    if (team.archived_at !== null) continue;
    if (seen.has(team.team_id)) continue;
    seen.add(team.team_id);
    out.push({ id: team.team_id, name: team.name, slug: team.slug });
  }
  return out;
});

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
  user: AuthedUser;
  orgId: string;
  orgName: string;
  /** The user's role in the resolved org: 'member' | 'manager' | 'super_admin'.
   *  Stored `manager` is the "Admin" tier (KTD1). */
  role: OrgRole;
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
    canInviteBot: isAdminRole(chosen.role) || chosen.canInviteBot,
  };
}

/**
 * Like {@link requireAuthedUserWithOrg}, but redirects users without ADMIN
 * POWER away. "Admin power" = role 'manager' (the stored Admin tier, KTD1) OR
 * 'super_admin' (which inherits all admin powers, KTD2). Use to gate admin-only
 * pages and server actions (Sources, Settings, member management). RLS (via
 * is_org_admin) is the real authorization boundary; this is the app-layer
 * defense-in-depth that also keeps members out of the UI.
 */
export async function requireAdmin(): Promise<AuthedOrgContext> {
  const ctx = await requireAuthedUserWithOrg();
  if (!isAdminRole(ctx.role)) {
    redirect('/upcoming');
  }
  return ctx;
}

/**
 * @deprecated Back-compat alias for {@link requireAdmin}. Existing callers named
 * this gate "requireManager"; its meaning is "admin power" (`is_org_admin`), which
 * now includes super_admin, so super_admins are no longer redirected away from
 * admin pages. Prefer `requireAdmin` in new code.
 */
export const requireManager = requireAdmin;

/**
 * Like {@link requireAuthedUserWithOrg}, but redirects everyone except a
 * super_admin away. Reserved for the audited master-key surfaces (audit-log
 * view). super_admin is the only role with role === 'super_admin'.
 */
export async function requireSuperAdmin(): Promise<AuthedOrgContext> {
  const ctx = await requireAuthedUserWithOrg();
  if (ctx.role !== 'super_admin') {
    redirect('/upcoming');
  }
  return ctx;
}
