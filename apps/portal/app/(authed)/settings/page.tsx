import { redirect } from 'next/navigation';

/**
 * /settings → bounce to the first available tab. Today that's
 * Meeting bot; once the full sub-nav (#24) lands, the default tab
 * choice may shift to Profile or Workspace.
 */
export default function SettingsIndexPage(): never {
  redirect('/settings/meeting-bot');
}
