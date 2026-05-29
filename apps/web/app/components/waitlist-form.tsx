'use client';

import { useId, useState } from 'react';

// Pragmatic email check — good enough for inline UX validation. Real
// verification would happen server-side once the form is wired up.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = 'idle' | 'error' | 'success';

export function WaitlistForm(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const inputId = useId();
  const errorId = useId();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const value = email.trim();
    if (value === '') {
      setError('Enter your email to request access.');
      setStatus('error');
      return;
    }
    if (!EMAIL_RE.test(value)) {
      setError("That doesn't look like a valid email.");
      setStatus('error');
      return;
    }

    // Presentation-only: no network request. A real endpoint
    // (e.g. app/api/waitlist/route.ts or an external provider) attaches here
    // later — see the landing-page plan, U7 / KTD6.
    setError('');
    setStatus('success');
  }

  return (
    <section id="waitlist" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
      <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card/50 p-8 text-center sm:p-10">
        <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
          Request early access
        </h2>
        <p className="mx-auto mt-3 max-w-md text-muted">
          Upwell is in early development on Linux, with macOS and Windows to follow. Leave your
          email and we&apos;ll reach out as spots open up.
        </p>

        {status === 'success' ? (
          <div
            role="status"
            className="mt-8 rounded-xl border border-accent/40 bg-[var(--synthesis-tint)] px-5 py-6"
          >
            <p className="font-semibold text-fg">You&apos;re on the list.</p>
            <p className="mt-1 text-sm text-muted">
              Thanks — we&apos;ll be in touch at {email.trim()}.
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            noValidate
            className="mx-auto mt-8 flex max-w-md flex-col gap-3 sm:flex-row"
          >
            <div className="flex-1 text-left">
              <label htmlFor={inputId} className="sr-only">
                Work email
              </label>
              <input
                id={inputId}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (status === 'error') {
                    setStatus('idle');
                    setError('');
                  }
                }}
                aria-invalid={status === 'error'}
                aria-describedby={status === 'error' ? errorId : undefined}
                className="w-full rounded-xl border border-border bg-bg px-4 py-3 text-fg outline-none transition-colors placeholder:text-muted focus:border-accent"
              />
              {status === 'error' && (
                <p id={errorId} className="mt-2 text-sm text-error">
                  {error}
                </p>
              )}
            </div>
            <button
              type="submit"
              className="rounded-xl bg-accent px-6 py-3 font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90"
            >
              Request access
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
