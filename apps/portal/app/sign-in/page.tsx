import type { ReactElement } from 'react';
import { Logo } from '../_components/logo';
import { GoogleSignInButton } from './google-sign-in-button';

/**
 * Sign-in page. Responsive layout:
 *   - Mobile (< lg): vertically stacked. Brand + rising-signals + tagline
 *     at the top (compact), sign-in form below. Page scrolls if content
 *     exceeds viewport.
 *   - Desktop (≥ lg): split-screen, fixed viewport height. Brand + signals
 *     + tagline fill the left column; form is vertically centered in the
 *     right column.
 *
 * Sign-in is the user's first impression post-landing-page — the sibling
 * sign-in route is NOT in (marketing)/ so the marketing SiteHeader +
 * SiteFooter chrome doesn't render here.
 *
 * Currently Google-only per R1. GitHub SSO + email magic link are tracked
 * as GH issues (#18, #19); both fit in the form column without restructuring.
 */
export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>;
}): ReactElement {
  return (
    <main className="flex min-h-dvh flex-col lg:grid lg:h-dvh lg:min-h-0 lg:grid-cols-2 lg:overflow-hidden">
      {/* Left / top: brand + signals + tagline */}
      <aside className="relative flex min-h-[60vh] flex-col overflow-hidden bg-accent/[0.06] p-6 sm:p-10 lg:min-h-0">
        <div className="relative z-10 flex items-center gap-3">
          <Logo size={40} className="text-accent" />
          <span className="text-2xl font-semibold tracking-tight sm:text-3xl">Risezome</span>
        </div>

        <RisingSignalsBackdrop />

        {/* Tagline block: pushed toward the bottom of the aside via mt-auto,
            with backdrop-blur over a faint surface tint so it reads cleanly
            against whichever dots/lines pass behind it. */}
        <div className="relative z-10 mb-4 mt-auto max-w-md space-y-3 rounded-2xl bg-bg/15 p-5 backdrop-blur-md sm:mb-12 sm:space-y-4 sm:p-6">
          <h2 className="text-3xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
            Answers, before<br />you ask.
          </h2>
          <p className="text-sm text-fg/80 sm:text-base">
            Risezome surfaces the right PR, ticket, and doc from your codebase the
            moment they come up in a meeting.
          </p>
        </div>
      </aside>

      {/* Right / bottom: sign-in form. On desktop the form is vertically
          centered in its column; on mobile it sits at the top of the lower
          section with comfortable padding. overflow-y-auto allows internal
          scroll on very short desktop viewports without breaking the split. */}
      <section className="flex flex-col items-center justify-start px-6 py-10 sm:py-12 lg:justify-center lg:overflow-y-auto">
        <div className="w-full max-w-sm space-y-8">
          <header className="space-y-1.5 text-center lg:text-left">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted">Sign in to your workspace.</p>
          </header>

          <SignInError searchParams={searchParams} />

          <GoogleSignInButton />

          <p className="text-center text-sm text-muted">
            New to Risezome?{' '}
            {/* Sign-in and create-workspace are the same OAuth flow — post-auth
                /onboarding detects zero-orgs and renders the create form. */}
            <a href="/sign-in" className="font-medium text-accent hover:text-accent-press">
              Create a workspace
            </a>
          </p>

          <p className="text-center text-xs text-muted">
            Beta. Provider costs absorbed; no payment required.
          </p>
        </div>
      </section>
    </main>
  );
}

/**
 * Decorative rising-signals SVG. Three gradient-stroked paths rise from
 * the bottom edge, with scattered filled + outlined dots. Positioned
 * absolute behind foreground content (z-index 0). The three line-end
 * dots are fully opaque so they cleanly cap each path.
 *
 * preserveAspectRatio="xMidYMax slice" anchors the pattern to bottom-
 * center so it always reads as rising from below regardless of viewport
 * aspect (mobile portrait or desktop landscape).
 */
function RisingSignalsBackdrop(): ReactElement {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 400 520"
      fill="none"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="rz-rising-signals" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#5159e0" />
          <stop offset="1" stopColor="#7c83ff" />
        </linearGradient>
      </defs>
      <path
        d="M40 520C60 380 120 360 110 250M200 520C190 360 250 320 240 200M360 520C340 400 290 380 300 270"
        stroke="url(#rz-rising-signals)"
        strokeWidth="1.5"
        opacity="0.5"
      />
      {/* The three line-end circles — fully opaque so the curve ends are
          covered cleanly and don't show through behind the dot. */}
      <circle cx="110" cy="250" r="4" fill="#7c83ff" />
      <circle cx="240" cy="200" r="5" fill="#7c83ff" />
      <circle cx="300" cy="270" r="3.5" fill="#7c83ff" />
      <circle cx="140" cy="330" r="3" fill="#7c83ff" opacity="0.5" />
      <circle cx="210" cy="300" r="2.6" fill="#7c83ff" opacity="0.85" />
      <circle cx="270" cy="360" r="3" fill="#7c83ff" opacity="0.5" />
      <circle cx="80" cy="160" r="3" fill="none" stroke="#7c83ff" strokeWidth="1.2" opacity="0.5" />
      <circle cx="330" cy="150" r="4" fill="none" stroke="#7c83ff" strokeWidth="1.2" opacity="0.5" />
      <circle cx="180" cy="110" r="2.6" fill="none" stroke="#7c83ff" strokeWidth="1.2" opacity="0.5" />
    </svg>
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
