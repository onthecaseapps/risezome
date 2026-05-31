import type { ReactElement } from 'react';
import { requireAuthedUser } from '../../../_lib/auth';
import { createOrg } from '../../onboarding/actions';

/**
 * Secondary org creation form, reachable from the OrgSwitcher's "+ Create
 * new org" item. Reuses the same createOrg server action as onboarding —
 * the difference is the user already has at least one org membership.
 */
export default async function NewOrgPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactElement> {
  await requireAuthedUser();
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Create a new workspace</h1>
        <p className="mt-2 text-sm text-muted">
          You&apos;ll be added as the admin. Switch between workspaces from the sidebar.
        </p>
      </header>

      {error !== undefined && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-error bg-error/10 p-3 text-sm text-error"
        >
          Couldn&apos;t create the workspace. Try again.
        </div>
      )}

      <form action={createOrg} className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium">Workspace name</span>
          <input
            name="name"
            type="text"
            required
            maxLength={100}
            placeholder="e.g. Acme Engineering"
            className="block w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
            autoFocus
          />
        </label>
        <div className="flex gap-3">
          <a
            href="/sources"
            className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium hover:border-accent"
          >
            Cancel
          </a>
          <button
            type="submit"
            className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-press"
          >
            Create workspace
          </button>
        </div>
      </form>
    </main>
  );
}
