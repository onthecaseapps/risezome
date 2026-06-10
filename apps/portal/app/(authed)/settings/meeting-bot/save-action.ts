'use server';

import { revalidatePath } from 'next/cache';
import { requireManager } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';

const BOT_SETTING_FIELDS = ['auto_join', 'record_transcribe', 'announce_on_join'] as const;
export type BotSettingField = (typeof BOT_SETTING_FIELDS)[number];

/**
 * Upsert ONE workspace bot setting. Admin-only (requireManager, an alias of
 * requireAdmin) — RLS now gates the INSERT/UPDATE on is_org_admin(), and the
 * user-scoped client is sufficient. The action also stamps `updated_by` for an
 * audit trail of who flipped what.
 *
 * Per-field on purpose: submitting all three booleans from render-time state
 * meant two stale tabs clobbered each other's toggles (last write wins across
 * ALL columns). A single-column write only touches what the user flipped —
 * on conflict, PostgREST updates only the provided columns; on first insert,
 * the DB defaults fill the rest (they match the page's render defaults).
 */
export async function saveBotSettingsAction(input: {
  field: BotSettingField;
  value: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { user, orgId } = await requireManager();

  // Defense in depth: `field` becomes a column name, so never trust the wire.
  if (!BOT_SETTING_FIELDS.includes(input.field) || typeof input.value !== 'boolean') {
    return { ok: false, error: 'invalid_field' };
  }

  const supabase = await createServerClient();
  const { error } = await supabase
    .from('workspace_bot_settings')
    .upsert(
      {
        org_id: orgId,
        [input.field]: input.value,
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
