import type { ReactElement } from 'react';

/**
 * Bottom-of-sidebar user identity + sign-out. Avatar shows initials in
 * a colored circle (no Gravatar / Google avatar fetch yet — adds another
 * round-trip per page render and the upstream Google profile picture isn't
 * cached anywhere; defer to a later polish unit).
 *
 * Sign-out is a POST form (matches /api/auth/sign-out's POST-only contract;
 * avoids accidental sign-out via link prefetch).
 */
export function UserCard({
  email,
  fullName,
}: {
  email: string;
  fullName?: string | undefined;
}): ReactElement {
  const display = fullName ?? email;
  const initials = initialsFor(display);

  return (
    <div className="border-t border-border p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{fullName ?? email.split('@')[0]}</div>
          <div className="truncate text-xs text-muted">{email}</div>
        </div>
        <form action="/api/auth/sign-out" method="post">
          <button
            type="submit"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-accent-soft/50 hover:text-fg"
            title="Sign out"
            aria-label="Sign out"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}

function initialsFor(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '?';
  // For "Jordan Lee" → "JL"; for "jordan@acme.dev" → "J".
  const parts = trimmed.split(/[\s.@]+/).filter((s) => s.length > 0);
  if (parts.length === 0) return trimmed.charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}
