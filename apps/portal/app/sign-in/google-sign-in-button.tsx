'use client';

import { useState, type ReactElement } from 'react';
import { getBrowserClient } from '../_lib/supabase-browser';

/**
 * "Sign in with Google" button. Initiates the OAuth flow via the browser
 * Supabase client; user lands at Google's consent screen, then redirects
 * to /api/auth/callback with the code.
 *
 * Scopes: calendar.events.readonly + the standard openid/email/profile
 * triplet. queryParams force access_type=offline AND prompt=consent —
 * both required for Google to return a refresh token. Get one wrong and
 * the access token expires in 1h with no recovery path.
 */
export function GoogleSignInButton(): ReactElement {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onClick(): Promise<void> {
    setLoading(true);
    setErrorMsg(null);
    try {
      const supabase = getBrowserClient();
      const origin = window.location.origin;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/api/auth/callback`,
          scopes: 'https://www.googleapis.com/auth/calendar.events.readonly openid email profile',
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      if (error !== null) {
        setErrorMsg(error.message);
        setLoading(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={loading}
        className="flex w-full items-center justify-center gap-3 rounded-lg bg-accent px-4 py-3 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-press disabled:opacity-60"
      >
        <GoogleGlyph />
        {loading ? 'Redirecting…' : 'Continue with Google'}
      </button>
      {errorMsg !== null && (
        <p role="alert" className="text-sm text-error">
          {errorMsg}
        </p>
      )}
    </div>
  );
}

function GoogleGlyph(): ReactElement {
  // Multi-color Google brand G. Sat inside a small white badge so it
  // stays brand-accurate on the indigo button background. Google's
  // brand guidelines specifically allow the multicolor G on dark / colored
  // buttons when housed in a white surface.
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white">
      <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
          fill="#4285F4"
        />
        <path
          d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
          fill="#34A853"
        />
        <path
          d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
          fill="#FBBC05"
        />
        <path
          d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
          fill="#EA4335"
        />
      </svg>
    </span>
  );
}
