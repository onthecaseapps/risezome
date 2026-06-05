'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  CURRENT_TEAM_COOKIE,
  listUserTeams,
  requireAuthedUserWithOrg,
} from '../../_lib/auth';

/**
 * Server action: set the current team "lens" for this session (mirrors
 * {@link switchOrg}). The lens scopes what Captures/Knowledge browse against;
 * it never grants access (RLS still enforces attendees-only visibility, U2).
 *
 * Validates the requested team_id is one the user actually belongs to in their
 * current org (so a tampered cookie or rogue form post can't set someone else's
 * team as the lens). The sentinel value 'all' (or empty) clears the lens back to
 * the "My meetings" view.
 */
export async function switchTeam(formData: FormData): Promise<void> {
  const { orgId } = await requireAuthedUserWithOrg();
  const target = formData.get('teamId');
  const cookieStore = await cookies();

  // 'all' / empty → clear the lens (My meetings across any team).
  if (typeof target !== 'string' || target.length === 0 || target === 'all') {
    cookieStore.delete(CURRENT_TEAM_COOKIE);
    revalidatePath('/', 'layout');
    return;
  }

  const teams = await listUserTeams(orgId);
  const ok = teams.some((t) => t.id === target);
  if (!ok) {
    // Not a member of that team; silently no-op (RLS would deny anyway, but the
    // cookie itself shouldn't carry an unowned team_id).
    return;
  }

  cookieStore.set(CURRENT_TEAM_COOKIE, target, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  revalidatePath('/', 'layout');
}
