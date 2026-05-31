'use client';

import { useEffect, useState } from 'react';

/**
 * Trello returns the token in the URL *fragment* (`#token=…`), which the server
 * never sees. This tiny client page reads the fragment + the `state` query
 * param and POSTs both to the server, which validates the state and stores the
 * org's Trello connection. Then it redirects back to /sources.
 */
export default function TrelloCallbackPage(): React.ReactElement {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const token = new URLSearchParams(hash).get('token');
    const state = new URLSearchParams(window.location.search).get('state');

    if (token === null || state === null) {
      window.location.replace('/sources?error=trello_callback_missing');
      return;
    }

    void (async () => {
      try {
        const res = await fetch('/api/trello/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, state }),
        });
        if (res.ok) {
          window.location.replace('/sources?notice=trello_connected');
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          window.location.replace(`/sources?error=${body.error ?? 'trello_connect_failed'}`);
        }
      } catch {
        setError('Could not reach the server. Please try connecting again.');
      }
    })();
  }, []);

  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="text-muted">{error ?? 'Connecting your Trello account…'}</p>
    </main>
  );
}
