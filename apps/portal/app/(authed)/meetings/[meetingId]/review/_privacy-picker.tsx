'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { setMeetingPrivacy } from '../privacy-action';
import {
  PRIVACY_LABEL,
  canEditPrivacy,
  privacyOptionsFor,
  type PrivacyLevel,
} from '../../../../_lib/privacy-levels';

/**
 * Meeting privacy control (permissions overhaul U6). PRESENTATION ONLY — the RLS
 * + the `setMeetingPrivacy` action enforce all security; this picker just mirrors
 * the floor visually (KTD7) and calls the action.
 *
 *   - Owner / admin → a <select> of the three levels. For a non-admin owner,
 *     levels MORE private than the org floor are disabled (the action + DB trigger
 *     reject them anyway; this is the visible mirror). An admin sees all levels
 *     (floor-exempt override).
 *   - Non-owner non-admin → a read-only badge of the current level (no picker).
 *
 * Ownership + admin + floor are resolved on the server (RSC) and passed as props.
 */
export function PrivacyPicker({
  meetingId,
  currentLevel,
  isOwner,
  isAdmin,
  floor,
}: {
  meetingId: string;
  currentLevel: PrivacyLevel;
  isOwner: boolean;
  isAdmin: boolean;
  floor: PrivacyLevel;
}): ReactElement {
  const [level, setLevel] = useState<PrivacyLevel>(currentLevel);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const options = useMemo(
    () => privacyOptionsFor({ isAdmin, floor, currentLevel: level }),
    [isAdmin, floor, level],
  );

  if (!canEditPrivacy({ isOwner, isAdmin })) {
    return <PrivacyBadge level={currentLevel} />;
  }

  function onChange(next: PrivacyLevel): void {
    const prev = level;
    setLevel(next);
    setError(null);
    start(async () => {
      const result = await setMeetingPrivacy(meetingId, next);
      if (!result.ok) {
        setLevel(prev);
        setError(messageFor(result.error));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-2 text-sm text-muted">
        <LockGlyph />
        <span className="hidden sm:inline">Visibility</span>
        <div className="relative">
          <select
            value={level}
            disabled={pending}
            onChange={(e) => onChange(e.target.value as PrivacyLevel)}
            className="cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pl-3 pr-8 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none disabled:opacity-60"
            aria-label="Meeting visibility"
          >
            {options.map((o) => (
              <option key={o.level} value={o.level} disabled={!o.selectable}>
                {o.label}
                {!o.selectable ? ' — below workspace floor' : ''}
              </option>
            ))}
          </select>
          <ChevronDown />
        </div>
      </label>
      {error !== null ? (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Read-only visibility badge (non-owner non-admin, and the captures grid). */
export function PrivacyBadge({ level }: { level: PrivacyLevel }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted">
      <LockGlyph />
      {PRIVACY_LABEL[level]}
    </span>
  );
}

function messageFor(error: string): string {
  switch (error) {
    case 'below_floor':
      return 'That level is more private than your workspace allows. Ask an admin to override.';
    case 'forbidden':
      return 'You don’t have permission to change this meeting’s visibility.';
    case 'invalid_level':
      return 'That visibility level isn’t available.';
    case 'not_found':
      return 'This meeting could not be found.';
    default:
      return error;
  }
}

/** Shared padlock glyph for the privacy controls. Size/stroke are parameterized
 *  so the picker (13px) and the captures badge (10px) can reuse one source. */
export function LockGlyph({ size = 13, strokeWidth = 2 }: { size?: number; strokeWidth?: number } = {}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

function ChevronDown(): ReactElement {
  return (
    <svg
      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
