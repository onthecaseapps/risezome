'use server';

import { revalidatePath } from 'next/cache';
import { requireManager } from '../../../_lib/auth';
import { createServiceRoleClient } from '../../../_lib/supabase-server';

/**
 * Rename the workspace (org). Admin-only (requireManager = requireAdmin).
 *
 * `orgs` has NO client write policy — writes are service-role only (init
 * migration discipline: members can only SELECT their orgs). So this uses the
 * service-role client, with the org resolved server-side from the authed
 * session and the write explicitly scoped by `id = orgId`. The admin gate +
 * server-resolved org are what make the RLS-bypassing write safe.
 */
export async function updateWorkspaceNameAction(
  name: string,
): Promise<{ ok: true; name: string } | { ok: false; error: 'empty_name' | 'name_too_long' | string }> {
  const { orgId } = await requireManager();

  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty_name' };
  if (trimmed.length > 100) return { ok: false, error: 'name_too_long' };

  const service = createServiceRoleClient();
  const { error } = await service
    .from('orgs')
    .update({ name: trimmed })
    .eq('id', orgId); // org-scoped: service-role bypasses RLS, scope explicitly
  if (error !== null) return { ok: false, error: error.message };

  revalidatePath('/settings/workspace');
  // The org brand shows in the top bar across the whole authed shell.
  revalidatePath('/', 'layout');
  return { ok: true, name: trimmed };
}
