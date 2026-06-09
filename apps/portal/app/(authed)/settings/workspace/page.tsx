import type { ReactElement } from 'react';
import { requireManager } from '../../../_lib/auth';
import { WorkspaceNameForm } from './_form';

/** Settings → Workspace. Admin-only (requireManager redirects non-admins). The
 *  workspace name is editable here; more workspace config can join this page. */
export default async function WorkspaceSettingsPage(): Promise<ReactElement> {
  const { orgName } = await requireManager();
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted">Settings</p>
        <h1 className="mt-1 text-4xl font-bold tracking-tight">Workspace</h1>
        <p className="mt-2 text-pretty text-muted">Your workspace name and configuration.</p>
      </header>
      <WorkspaceNameForm initialName={orgName} />
    </div>
  );
}
