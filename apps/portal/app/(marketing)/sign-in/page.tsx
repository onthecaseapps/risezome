import type { ReactElement } from 'react';
import { Logo } from '../../_components/logo';
import { GoogleSignInButton } from './google-sign-in-button';

/**
 * Sign-in page. Split-screen: brand + tagline on the left (dark in dark
 * mode, soft indigo wash in light), sign-in form on the right.
 *
 * Currently Google-only per R1. Future SSO providers (GitHub) and the
 * magic-link email fallback are tracked as GH issues; they'll fit in the
 * same form column without restructuring.
 */
export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>;
}): ReactElement {
  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-2">
      {/* Left: brand + tagline */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-accent/[0.06] p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <Logo size={28} className="text-accent" />
          <span className="text-base font-semibold tracking-tight">Risezome</span>
        </div>
        <div className="relative z-10 space-y-4">
          <h2 className="text-4xl font-semibold tracking-tight">
            Answers, before<br />you ask.
          </h2>
          <p className="max-w-sm text-sm text-muted">
            Risezome surfaces the right PR, ticket, and doc from your codebase the moment
            they come up in a meeting.
          </p>
        </div>
      </aside>

      {/* Right: sign-in form */}
      <section className="flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          {/* Mobile-only brand (left aside is hidden < lg) */}
          <div className="flex items-center justify-center gap-2.5 lg:hidden">
            <Logo size={28} className="text-accent" />
            <span className="text-base font-semibold tracking-tight">Risezome</span>
          </div>

          <header className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted">Sign in to your workspace.</p>
          </header>

          <SignInError searchParams={searchParams} />

          <GoogleSignInButton />

          <p className="text-center text-sm text-muted">
            New to Risezome?{' '}
            {/* Same OAuth flow — sign-in and "create workspace" both land at /onboarding
                after auth; the onboarding page detects zero-orgs and renders the
                workspace-creation form. */}
            <a href="/sign-in" className="font-medium text-accent hover:text-accent-press">
              Create a workspace
            </a>
          </p>
        </div>

        <p className="mt-12 text-center text-xs text-muted">
          Beta. Provider costs absorbed; no payment required.
        </p>
      </section>
    </main>
  );
}

async function SignInError({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>;
}): Promise<ReactElement | null> {
  const { error, reason } = await searchParams;
  if (error === undefined) return null;
  const message = describeError(error, reason);
  return (
    <div
      role="alert"
      className="rounded-md border border-error bg-error/10 p-3 text-sm text-error"
    >
      {message}
    </div>
  );
}

function describeError(code: string, reason: string | undefined): string {
  switch (code) {
    case 'missing_code':
      return 'Sign-in was interrupted before it could complete. Try again.';
    case 'server_misconfigured':
      return 'Sign-in is temporarily unavailable. The server is missing required configuration.';
    case 'exchange_failed':
      return reason !== undefined && reason.length > 0
        ? `Google sign-in failed: ${decodeURIComponent(reason)}`
        : 'Google sign-in failed. Try again, or contact support if it keeps happening.';
    default:
      return 'Sign-in failed. Try again.';
  }
}
