import type { ReactElement } from 'react';
import { Logo } from '../_components/logo';
import { GoogleSignInButton } from './google-sign-in-button';

/**
 * Sign-in page. Split-screen: brand + rising-signals SVG on the left,
 * sign-in form on the right. Sign-in is the user's first impression of
 * Risezome (post-landing-page); the layout is self-contained — the
 * sibling sign-in/layout.tsx overrides the marketing chrome so there's
 * no duplicate wordmark / nav competing for attention.
 *
 * Layout strategy:
 *   - Fixed h-dvh on the outer grid (exact viewport height, no scroll).
 *   - Each column is its own flex container with internal layout.
 *   - Left aside: brand pinned top-left; tagline + copy block centered
 *     vertically with safe padding so it never clips against the bottom.
 *   - Right column: form vertically centered, overflow-y-auto for short
 *     viewports.
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
    <main className="grid h-dvh grid-cols-1 lg:grid-cols-2 overflow-hidden">
      {/* Left: brand wordmark top-left, tagline + copy block vertically
          centered low. The RisingSignalsBackdrop fills the column behind
          the foreground content. */}
      <aside className="relative hidden flex-col overflow-hidden bg-accent/[0.06] p-10 lg:flex">
        <div className="relative z-10 flex items-center gap-3">
          <Logo size={44} className="text-accent" />
          <span className="text-3xl font-semibold tracking-tight">Risezome</span>
        </div>

        <RisingSignalsBackdrop />

        {/* Anchored block: centered in the lower-half of the column.
            mt-auto pushes it down from the brand; mb-12 leaves breathing
            room above the bottom edge so the paragraph never clips.
            backdrop-blur with a faint bg tint isolates the text from the
            rising-signals SVG behind it so it stays readable regardless
            of which dots/lines pass behind. */}
        <div className="relative z-10 mb-12 mt-auto max-w-md space-y-4 rounded-2xl bg-bg/30 p-6 backdrop-blur-md">
          <h2 className="text-5xl font-semibold leading-[1.05] tracking-tight">
            Answers, before<br />you ask.
          </h2>
          <p className="text-base text-fg/80">
            Risezome surfaces the right PR, ticket, and doc from your codebase the
            moment they come up in a meeting.
          </p>
        </div>
      </aside>

      {/* Right: sign-in form. overflow-y-auto so it scrolls internally on
          short viewports without breaking the split-screen shape. */}
      <section className="flex flex-col items-center justify-center overflow-y-auto px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          {/* Mobile brand (the aside is hidden < lg). */}
          <div className="flex items-center justify-center gap-3 lg:hidden">
            <Logo size={34} className="text-accent" />
            <span className="text-xl font-semibold tracking-tight">Risezome</span>
          </div>

          <header className="space-y-1.5">
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
 * Decorative rising-signals SVG that fills the brand aside. Three
 * curving gradient-stroked paths rise from the bottom edge, with
 * scattered filled + outlined dots. Positioned absolute behind
 * foreground content (z-index 0).
 *
 * Source paths from the Login design mockup, cleaned of inline-style
 * noise. preserveAspectRatio="xMidYMax slice" anchors the pattern to
 * bottom-center so it always reads as rising from below.
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
