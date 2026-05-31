'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CURRENT_ORG_COOKIE, listUserOrgs, requireAuthedUser } from '../../_lib/auth';

/**
 * Server action: switch the current org for this session.
 *
 * Validates the requested org_id is one the user actually belongs to (so a
 * tampered cookie or rogue form post can't grant access to someone else's
 * org). On invalid input, silently no-op back to /sources — RLS would deny
 * anything anyway, but the cookie itself shouldn't carry an unowned org_id.
 */
export async function switchOrg(formData: FormData): Promise<void> {
  await requireAuthedUser();
  const target = formData.get('orgId');
  if (typeof target !== 'string' || target.length === 0) return;

  const orgs = await listUserOrgs();
  const ok = orgs.some((o) => o.id === target);
  if (!ok) {
    // Not a member; redirect home and let requireAuthedUserWithOrg
    // pick a real one.
    redirect('/sources');
  }

  const cookieStore = await cookies();
  cookieStore.set(CURRENT_ORG_COOKIE, target, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  redirect('/sources');
}
