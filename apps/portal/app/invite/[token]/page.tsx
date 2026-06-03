import { type ReactElement, type ReactNode } from 'react';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { GoogleSignInButton } from '../../sign-in/google-sign-in-button';
import { acceptInviteAction } from './accept-action';

/**
 * Invite preview + accept page. Public route (the invitee has no membership
 * yet), so the invite is read via the service-role client. Anonymous visitors
 * are routed through Google sign-in with next=/invite/<token>; signed-in
 * visitors get a Join button that posts to the accept action.
 *
 * Note: the page intentionally discloses the org name + role to any token
 * holder — shareable links are bearer auth by design. The 7-day expiry and
 * single-use redemption are the scope-limiting controls.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactElement> {
  const { token } = await params;
  const { error: errorCode } = await searchParams;

  const service = createServiceRoleClient();
  // service-role-cross-org: invite preview for an anonymous/not-yet-member visitor;
  // the unguessable invite token is the cross-org-safe key (org is not yet known).
  const { data: invite } = await service
    .from('org_invites')
    .select('token, role, expires_at, org:orgs(name)')
    .eq('token', token)
    .maybeSingle();

  const expired = invite !== null && new Date(invite.expires_at as string) <= new Date();
  if (invite === null || expired) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight">
          {expired ? 'This invite has expired' : 'Invite not found'}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {expired
            ? 'Ask whoever invited you to send a fresh link.'
            : 'This invite link is invalid or has already been used.'}
        </p>
      </Shell>
    );
  }

  const orgField = invite.org as unknown as { name: string } | { name: string }[] | null;
  const org = Array.isArray(orgField) ? orgField[0] : orgField;
  const orgName = org?.name ?? 'a workspace';
  const role = invite.role as string;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight">
        You’ve been invited to join <span className="text-accent">{orgName}</span>
      </h1>
      <p className="mt-2 text-sm text-muted">
        as a {role === 'manager' ? 'manager' : 'member'}
        {role === 'manager'
          ? ' — you’ll be able to manage sources, settings, the bot, and members.'
          : ' — you’ll see your own upcoming meetings and captures.'}
      </p>

      {errorCode !== undefined && (
        <p role="alert" className="mt-4 text-sm text-error">
          {errorMessage(errorCode)}
        </p>
      )}

      <div className="mt-6">
        {user !== null ? (
          <form action={acceptInviteAction}>
            <input type="hidden" name="token" value={token} />
            <button
              type="submit"
              className="w-full rounded-lg bg-accent px-4 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-press"
            >
              Join {orgName}
            </button>
          </form>
        ) : (
          <GoogleSignInButton next={`/invite/${token}`} />
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">{children}</div>
    </main>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case 'expired':
      return 'This invite has expired. Ask for a fresh link.';
    case 'invalid':
      return 'This invite is no longer valid.';
    case 'join_failed':
      return 'Something went wrong joining the workspace. Try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}
