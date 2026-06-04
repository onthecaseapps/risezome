import type { ReactElement } from 'react';
import { requireAdmin } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';
import { toPrivacyLevel } from '../../../_lib/privacy-levels';
import { PrivacyConfigForm } from './_form';

/**
 * Settings → Workspace privacy (permissions overhaul U7). ADMIN-ONLY
 * (requireAdmin → manager OR super_admin). Sets the org's two privacy knobs:
 *
 *   default_privacy — the level stamped onto NEW meetings at creation.
 *   privacy_floor   — the most-private level a normal (non-admin) owner may pick.
 *
 * The config row is read via the RLS-scoped authed client (org members may SELECT
 * org_privacy_config). The write goes through setOrgPrivacyConfig (service-role,
 * admin-gated; org_privacy_config has no client write policy — KTD6). Defaults
 * match the migration: default_privacy='only_teammates', privacy_floor='only_me'.
 */
export default async function PrivacySettingsPage(): Promise<ReactElement> {
  const { orgId, orgName } = await requireAdmin();
  const supabase = await createServerClient();

  const { data } = await supabase
    .from('org_privacy_config')
    .select('default_privacy, privacy_floor')
    .eq('org_id', orgId)
    .maybeSingle();

  const defaultPrivacy = toPrivacyLevel((data?.default_privacy as string | null) ?? 'only_teammates');
  const floor = toPrivacyLevel((data?.privacy_floor as string | null) ?? 'only_me');

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Workspace privacy</h1>
        <p className="mt-1.5 text-sm text-muted">
          Control the default visibility of new meetings in{' '}
          <span className="text-fg">{orgName}</span> and the most-private level members may choose
          for their own.
        </p>
      </header>

      <PrivacyConfigForm initialDefault={defaultPrivacy} initialFloor={floor} />
    </div>
  );
}
