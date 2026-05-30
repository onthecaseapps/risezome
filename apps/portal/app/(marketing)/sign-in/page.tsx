import type { ReactElement } from 'react';
import { GoogleSignInButton } from './google-sign-in-button';

/**
 * Sign-in page. Currently Google-only per R1. Future providers (GitHub
 * for sign-in convenience, Microsoft for Outlook calendar later) hang
 * off here as additional buttons.
 *
 * Renders inside the marketing route group (no auth required to view).
 * The page is intentionally minimal — no marketing copy, no testimonials.
 * Get the user to a click and out.
 */
export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>;
}): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6">
      <div className="w-full space-y-6">
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to Risezome</h1>
          <p className="mt-2 text-sm text-muted">
            Use your Google account. We&apos;ll ask for calendar access so the bot can join
            the meetings you opt into.
          </p>
        </header>

        <SignInError searchParams={searchParams} />

        <GoogleSignInButton />

        <p className="text-center text-xs text-muted">
          By signing in, you agree to be a beta tester for Risezome. No paid plans yet; provider
          costs absorbed during beta.
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
      className="rounded-md border border-[var(--error,#b30000)] bg-[var(--error,#b30000)]/10 p-3 text-sm"
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
