'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { toggleBotOptInAction } from './opt-in-action';

/**
 * Per-row opt-in toggle. Optimistic UI: flip the switch immediately,
 * fall back if the server rejects.
 *
 * Disabled when platform is not zoom/meet — Recall.ai's MVP integration
 * covers those two; Teams/Webex/other are listed-only until later.
 */
export function OptInToggle({
  eventId,
  initial,
  platform,
}: {
  eventId: string;
  initial: boolean;
  platform: 'zoom' | 'meet' | 'other' | null;
}): ReactElement {
  const eligible = platform === 'zoom' || platform === 'meet';
  const [optedIn, setOptedIn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggle() {
    if (!eligible || pending) return;
    const next = !optedIn;
    setOptedIn(next); // optimistic
    setError(null);

    const fd = new FormData();
    fd.set('eventId', eventId);
    fd.set('bot_optin', next ? 'true' : 'false');

    startTransition(async () => {
      const result = await toggleBotOptInAction(fd);
      if (!result.ok) {
        setOptedIn(!next); // revert
        setError(humanError(result.error));
      }
    });
  }

  const label = !eligible
    ? `Bot join not yet supported on ${platform ?? 'this platform'}`
    : optedIn
    ? 'Risezome will join this meeting'
    : 'Send Risezome to this meeting';

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={optedIn && eligible}
        aria-label={label}
        title={label}
        disabled={!eligible || pending}
        onClick={handleToggle}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          optedIn && eligible ? 'bg-accent' : 'bg-border'
        }`}
      >
        <span
          aria-hidden
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
            optedIn && eligible ? 'translate-x-4' : 'translate-x-0.5'
          } translate-y-[1px]`}
        />
      </button>
      {error !== null ? (
        <span className="text-[11px] text-rose-400">{error}</span>
      ) : null}
    </div>
  );
}

function humanError(code: string): string {
  if (code === 'missing_event_id') return 'Internal error';
  return code.slice(0, 60);
}
