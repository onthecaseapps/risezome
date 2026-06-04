'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Org privacy-config write action (permissions overhaul U4; KTD6).
 *
 * `setOrgPrivacyConfig(default_privacy, privacy_floor)` upserts the org's
 * privacy defaults: the level NEW meetings are stamped with (default_privacy) and
 * the most-private level a normal owner write may pick (privacy_floor). Admin-only
 * (manager OR super_admin via requireAdmin) and org-scoped. org_privacy_config has
 * no client write policy, so this service-role action is the only write surface
 * (KTD6).
 *
 * AUDIT NOTE: this is an org-config change, not a per-meeting privacy change, and
 * the audit log's `action` CHECK only admits privacy_change / admin_override /
 * role_change / master_key_access. Rather than overload one of those with a
 * null-target row of ambiguous meaning, we keep this action UN-audited for v1
 * (documented). updated_by on the config row already records who last changed it;
 * a dedicated 'config_change' action can be added later if the audit view needs it.
 */

const LEVELS = ['only_me', 'only_participants', 'only_teammates'] as const;
type PrivacyLevel = (typeof LEVELS)[number];

type ActionResult = { ok: true } | { ok: false; error: string };

export async function setOrgPrivacyConfig(
  defaultPrivacy: string,
  privacyFloor: string,
): Promise<ActionResult> {
  if (!isPrivacyLevel(defaultPrivacy) || !isPrivacyLevel(privacyFloor)) {
    return { ok: false, error: 'invalid_level' };
  }

  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  const { error } = await service.from('org_privacy_config').upsert(
    {
      org_id: orgId,
      default_privacy: defaultPrivacy,
      privacy_floor: privacyFloor,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    },
    { onConflict: 'org_id' },
  );
  if (error !== null) return { ok: false, error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}

function isPrivacyLevel(v: string): v is PrivacyLevel {
  return (LEVELS as readonly string[]).includes(v);
}
