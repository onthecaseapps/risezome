import type { ReactElement } from 'react';
import { Logo } from '../../_components/logo';
import { GoogleSignInButton } from './google-sign-in-button';

/**
 * Sign-in page. Currently Google-only per R1. Future providers (GitHub,
 * Microsoft) hang off here as additional buttons.
 *
 * Calm layout: centered card on a soft background. Brand at top so the
 * sign-in surface reads as Risezome's, not as an anonymous OAuth form.
 */
export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>;
}): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6">
      <div className="w-full space-y-8">
        <header className="flex flex-col items-center gap-3 text-center">
          <Logo size={44} className="text-accent" />
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to Risezome</h1>
          <p className="max-w-sm text-sm text-muted">
            Answers, before you ask. We&apos;ll request calendar access so the bot can join
            the meetings you opt into.
          </p>
        </header>

        <SignInError searchParams={searchParams} />

        <GoogleSignInButton />

        <p className="text-center text-xs text-muted">
          By signing in, you agree to be a beta tester. No paid plans yet; provider costs
          absorbed during beta.
        </p>
      </div>
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
