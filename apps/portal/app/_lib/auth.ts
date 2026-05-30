import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createServerClient } from './supabase-server';

/**
 * Returns the current Supabase user, or redirects to /sign-in if there is no
 * session. Use in Server Components and Server Actions on `(authed)` routes.
 *
 * U2 fills in the sign-in route and exchangeCodeForSession callback; this
 * helper exists in U1 as the integration point so authed pages can be
 * written against a stable contract from the start.
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
 * Returns the current user + their current org_id, or redirects:
 *   - to /sign-in if no session
 *   - to /onboarding if signed in but no org membership yet
 *
 * `current_org_id` is read from the `current_org_id` cookie (set by the
 * org switcher in U3) and validated against `org_members`. If the cookie
 * is missing or stale, falls back to the user's first membership.
 *
 * U3 builds out the onboarding flow and the org switcher; this helper
 * exists in U1 as the contract.
 */
export async function requireAuthedUserWithOrg(): Promise<{
  user: User;
  orgId: string;
}> {
  const user = await requireAuthedUser();
  const supabase = await createServerClient();
  const { data: memberships, error } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id);
  if (error !== null) {
    throw new Error(`Failed to load org memberships: ${error.message}`);
  }
  if (memberships === null || memberships.length === 0) {
    redirect('/onboarding');
  }
  // current_org_id cookie validation lands in U3 alongside the switcher. For
  // U1 we return the first membership unconditionally so server components
  // can compile against this signature.
  const first = memberships[0];
  if (first === undefined) redirect('/onboarding');
  return { user, orgId: first.org_id as string };
}
