import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import { Logo } from '../../_components/logo';
import { listUserOrgs, requireAuthedUser } from '../../_lib/auth';
import { createOrg } from './actions';

/**
 * First-time onboarding. Shown when the user has no org memberships yet.
 * Users with at least one membership redirect to /sources — no
 * second-create-org loop.
 *
 * Renders inside the (authed) layout but the sidebar's nav links are mostly
 * disabled (no org context yet); only the Risezome wordmark + (eventual)
 * user card are present. Visually the page reads as a centered welcome.
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-12">
      <div className="w-full space-y-8">
        <header className="flex flex-col items-center gap-3 text-center">
          <Logo size={40} className="text-accent" />
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to Risezome</h1>
          <p className="max-w-sm text-sm text-muted">
            Let&apos;s name your workspace. You can rename it later in Settings, and add more
            workspaces from the sidebar.
          </p>
        </header>

        {error !== undefined && <OnboardingError code={error} />}

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
          <button
            type="submit"
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-press"
          >
            Create workspace
          </button>
        </form>
      </div>
    </main>
  );
}

function OnboardingError({ code }: { code: string }): ReactElement {
  let message: string;
  switch (code) {
    case 'empty_name':
      message = 'Workspace name is required.';
      break;
    case 'name_too_long':
      message = 'Workspace name must be 100 characters or less.';
      break;
    case 'create_failed':
      message = 'Couldn’t create the workspace. Try again, or contact support if it keeps happening.';
      break;
    default:
      message = 'Something went wrong. Try again.';
  }
  return (
    <div
      role="alert"
      className="rounded-md border border-error bg-error/10 p-3 text-sm text-error"
    >
      {message}
    </div>
  );
}
