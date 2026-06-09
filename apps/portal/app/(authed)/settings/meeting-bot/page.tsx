import type { ReactElement } from 'react';
import { requireManager } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';
import { SettingsForm } from './_form';

/**
 * Settings → Meeting bot. Workspace-scoped toggles for how the bot
 * behaves by default. Schema: workspace_bot_settings (one row per org).
 *
 * Three toggles per the design mockup:
 *   - Auto-join scheduled meetings (default OFF, preserves R8)
 *   - Record & transcribe (default ON, transcribe-always per R20)
 *   - Announce the bot on join (default ON, per R10)
 *
 * The form is a client component that POSTs a server action; values
 * persist via service-role-bypassing RLS (the RLS policy is permissive
 * for org members but the action verifies membership server-side).
 */
export default async function MeetingBotSettingsPage(): Promise<ReactElement> {
  const { orgId, orgName } = await requireManager();

  const supabase = await createServerClient();
  const { data } = await supabase
    .from('workspace_bot_settings')
    .select('auto_join, record_transcribe, announce_on_join, updated_at')
    .eq('org_id', orgId)
    .maybeSingle();

  // Row-absent → all defaults apply. We don't lazy-create on render;
  // the first save inserts the row.
  const settings = data ?? {
    auto_join: false,
    record_transcribe: true,
    announce_on_join: true,
    updated_at: null,
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted">Settings</p>
        <h1 className="mt-1 text-4xl font-bold tracking-tight">Meeting bot</h1>
        <p className="mt-2 text-pretty text-muted">
          Defaults for <span className="text-fg">{orgName}</span>. Apply to every meeting unless overridden per-meeting.
        </p>
      </header>

      <SettingsForm initial={settings as InitialSettings} />
    </div>
  );
}

export interface InitialSettings {
  auto_join: boolean;
  record_transcribe: boolean;
  announce_on_join: boolean;
  updated_at: string | null;
}
