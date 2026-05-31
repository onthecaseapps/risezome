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
    setOptedIn(next);
    setError(null);

    const fd = new FormData();
    fd.set('eventId', eventId);
    fd.set('bot_optin', next ? 'true' : 'false');

    startTransition(async () => {
      const result = await toggleBotOptInAction(fd);
      if (!result.ok) {
        setOptedIn(!next);
        setError(humanError(result.error));
      }
    });
  }

  // Unsupported platforms render as a static pill instead of a greyed
  // toggle — matches the mockup and gives the user a clearer "no" than
  // a faded switch.
  if (!eligible) {
    return (
      <div className="flex flex-col items-end gap-0.5 text-right">
        <span
          className="inline-flex items-center rounded-full bg-bg/60 px-2.5 py-1 text-[11px] font-medium text-muted"
          title={`${platform ?? 'This platform'} bot join isn't available yet`}
        >
          Not supported
        </span>
        {platform === 'other' ? (
          <span className="text-[11px] text-muted">Teams support is coming soon</span>
        ) : null}
      </div>
    );
  }

  const label = optedIn ? 'Risezome will join this meeting' : 'Send Risezome to this meeting';
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted">Bot</span>
      <button
        type="button"
        role="switch"
        aria-checked={optedIn}
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={handleToggle}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border border-transparent transition-colors disabled:cursor-wait ${
          optedIn ? 'bg-accent' : 'bg-border'
        }`}
      >
        <span
          aria-hidden
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
            optedIn ? 'translate-x-4' : 'translate-x-0.5'
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
  const map: Record<string, string> = {
    missing_event_id: 'Internal error',
    event_not_found: 'Event not found',
    unsupported_platform: 'Bot join not available for this platform',
    no_conference_url: 'No conference link on this event',
    past_meeting: "That meeting has already started",
  };
  return map[code] ?? code.slice(0, 60);
}
