import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import { listUserOrgs, requireAuthedUser } from '../../_lib/auth';
import { MembersIcon, SourcesIcon, CapturesIcon, GapsIcon } from '../_components/nav-icons';
import { primaryButtonClass } from '../_components/ui';
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
  // Users with at least one membership never see onboarding — straight to the app.
  if (orgs.length > 0) {
    redirect('/sources');
  }

  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center px-6 py-12">
      <div className="w-full space-y-8">
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to Risezome</h1>
          <p className="max-w-sm text-sm text-muted">
            A workspace is your team&apos;s private corner of Risezome. Its members, sources, and
            the answers grounded from them all live inside it. Name your first one to begin.
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
          <button type="submit" className={`${primaryButtonClass} w-full`}>
            Create workspace
          </button>
        </form>

        <WorkspaceExplainer />
      </div>
    </main>
  );
}

/**
 * First-run primer: what's scoped to a workspace, and why a team might keep
 * several. The "why" is the load-bearing part — new users default to one
 * catch-all workspace and only later discover that mixing every team's sources
 * dilutes answers and erases the privacy boundary.
 */
function WorkspaceExplainer(): ReactElement {
  const items: Array<{ icon: ReactElement; label: string; desc: string }> = [
    { icon: <MembersIcon />, label: 'Members', desc: 'Who can ask and see answers' },
    { icon: <SourcesIcon />, label: 'Sources', desc: 'The repos, boards & docs it searches' },
    { icon: <CapturesIcon />, label: 'Captures', desc: 'Meetings the bot recorded' },
    { icon: <GapsIcon />, label: 'Knowledge gaps', desc: 'Questions that couldn’t be answered' },
  ];
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card/40 p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">
        What lives in a workspace
      </p>
      <ul className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
        {items.map((it) => (
          <li key={it.label} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent">
              {it.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{it.label}</span>
              <span className="block text-xs leading-snug text-muted">{it.desc}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border/70 pt-3.5 text-sm text-muted">
        <span className="font-medium text-fg">Tip: keep one workspace per team.</span>{' '}
        Each searches only its own sources, so answers stay focused and a team&apos;s private
        context never crosses into another&apos;s.
      </p>
    </div>
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
