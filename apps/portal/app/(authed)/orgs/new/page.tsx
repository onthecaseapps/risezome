import type { ReactElement } from 'react';
import { requireAuthedUser } from '../../../_lib/auth';
import { createOrg } from '../../onboarding/actions';

/**
 * Secondary org creation form, reachable from the OrgSwitcher's "+ Create
 * new org" item. Reuses the same createOrg server action as onboarding —
 * the difference is the user already has at least one org membership at
 * this point.
 */
export default async function NewOrgPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactElement> {
  await requireAuthedUser();
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-md py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Create a new team</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          You&apos;ll be added as the admin. You can switch between teams from the topbar.
        </p>
      </header>

      {error !== undefined && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-[var(--error,#b30000)] bg-[var(--error,#b30000)]/10 p-3 text-sm"
        >
          Couldn&apos;t create the team. Try again.
        </div>
      )}

      <form action={createOrg} className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Team name</span>
          <input
            name="name"
            type="text"
            required
            maxLength={100}
            placeholder="e.g. Acme Engineering"
            className="block w-full rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-3 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
            autoFocus
          />
        </label>
        <div className="flex gap-3">
          <a
            href="/sources"
            className="rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-4 py-2.5 text-sm font-medium"
          >
            Cancel
          </a>
          <button
            type="submit"
            className="flex-1 rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            Create team
          </button>
        </div>
      </form>
    </main>
  );
}
