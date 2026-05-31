import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import { listUserOrgs, requireAuthedUser } from '../../_lib/auth';
import { createOrg } from './actions';

/**
 * First-time onboarding. Shown when the user has no org memberships yet.
 * Users with at least one membership are redirected to /sources — no
 * second-create-org loop.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactElement> {
  await requireAuthedUser();
  const orgs = await listUserOrgs();
  if (orgs.length > 0) {
    redirect('/sources');
  }

  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-md py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Risezome</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Let&apos;s set up your team. You can rename it later in Settings.
        </p>
      </header>

      {error !== undefined && <OnboardingError code={error} />}

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
        <button
          type="submit"
          className="w-full rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
        >
          Create team
        </button>
      </form>
    </main>
  );
}

function OnboardingError({ code }: { code: string }): ReactElement {
  let message: string;
  switch (code) {
    case 'empty_name':
      message = 'Team name is required.';
      break;
    case 'name_too_long':
      message = 'Team name must be 100 characters or less.';
      break;
    case 'create_failed':
      message = 'Couldn’t create the team. Try again, or contact support if it keeps happening.';
      break;
    default:
      message = 'Something went wrong. Try again.';
  }
  return (
    <div
      role="alert"
      className="mb-6 rounded-md border border-[var(--error,#b30000)] bg-[var(--error,#b30000)]/10 p-3 text-sm"
    >
      {message}
    </div>
  );
}
