'use server';

import { revalidatePath } from 'next/cache';
import { requireManager } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';

/**
 * Upsert workspace bot settings. Admin-only (requireManager, an alias of
 * requireAdmin) — RLS now gates the INSERT/UPDATE on is_org_admin(), and the
 * user-scoped client is sufficient. The action also stamps `updated_by` for an
 * audit trail of who flipped what.
 */
export async function saveBotSettingsAction(input: {
  auto_join: boolean;
  record_transcribe: boolean;
  announce_on_join: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { user, orgId } = await requireManager();
  const supabase = await createServerClient();

  const { error } = await supabase
    .from('workspace_bot_settings')
    .upsert(
      {
        org_id: orgId,
        auto_join: input.auto_join,
        record_transcribe: input.record_transcribe,
        announce_on_join: input.announce_on_join,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      },
      { onConflict: 'org_id' },
    );

  if (error !== null) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/settings/meeting-bot');
  return { ok: true };
}
