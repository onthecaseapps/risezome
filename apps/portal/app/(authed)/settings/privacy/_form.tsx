'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { setOrgPrivacyConfig } from '../privacy-action';
import {
  PRIVACY_LABEL,
  PRIVACY_LEVELS,
  PRIVACY_RANK,
  type PrivacyLevel,
} from '../../../_lib/privacy-levels';

/**
 * Workspace-privacy config form (permissions overhaul U7). Two selects — the org
 * default for new meetings and the privacy floor — saved together via
 * setOrgPrivacyConfig. PRESENTATION ONLY: the action is admin-gated + service-role
 * (KTD6); this just collects the two levels. Optimistic with rollback on failure.
 */
export function PrivacyConfigForm({
  initialDefault,
  initialFloor,
}: {
  initialDefault: PrivacyLevel;
  initialFloor: PrivacyLevel;
}): ReactElement {
  const [defaultPrivacy, setDefaultPrivacy] = useState<PrivacyLevel>(initialDefault);
  const [floor, setFloor] = useState<PrivacyLevel>(initialFloor);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function save(nextDefault: PrivacyLevel, nextFloor: PrivacyLevel): void {
    const prevDefault = defaultPrivacy;
    const prevFloor = floor;

    // Prevent a default MORE private than the floor (rank(default) < rank(floor)):
    // every new meeting would be stamped below the floor the trigger enforces. The
    // server rejects this too (default_below_floor); we block it before the round
    // trip and explain why. Mirrors the DB CHECK / action guard.
    if (PRIVACY_RANK[nextDefault] < PRIVACY_RANK[nextFloor]) {
      setError(
        'The default visibility can’t be more private than the floor. Lower the floor first, or pick a less-private default.',
      );
      setSaved(false);
      return;
    }

    setDefaultPrivacy(nextDefault);
    setFloor(nextFloor);
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await setOrgPrivacyConfig(nextDefault, nextFloor);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } else {
        setDefaultPrivacy(prevDefault);
        setFloor(prevFloor);
        setError(messageForConfigError(result.error));
      }
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <SectionLabel label="Defaults" />
      <ConfigRow
        title="Default visibility for new meetings"
        description="The visibility stamped on every new meeting. Owners can still change theirs afterward."
        value={defaultPrivacy}
        disabled={pending}
        onChange={(v) => save(v, floor)}
      />
      <ConfigRow
        title="Privacy floor"
        description="The most-private level members may choose for their own meetings. Admins can override any meeting below this floor."
        value={floor}
        disabled={pending}
        onChange={(v) => save(defaultPrivacy, v)}
      />
      {error !== null ? (
        <div className="border-t border-border bg-rose-500/10 px-5 py-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {saved ? (
        <div className="border-t border-border px-5 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          Saved.
        </div>
      ) : null}
    </div>
  );
}

function messageForConfigError(error: string): string {
  switch (error) {
    case 'invalid_level':
      return 'That visibility level isn’t available.';
    case 'default_below_floor':
      return 'The default visibility can’t be more private than the floor.';
    default:
      return error;
  }
}

function SectionLabel({ label }: { label: string }): ReactElement {
  return (
    <div className="border-b border-border px-5 py-3 text-xs font-medium uppercase tracking-wider text-muted">
      {label}
    </div>
  );
}

function ConfigRow({
  title,
  description,
  value,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  value: PrivacyLevel;
  disabled?: boolean;
  onChange: (v: PrivacyLevel) => void;
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="mt-1 text-xs text-muted">{description}</p>
      </div>
      <div className="relative mt-0.5 flex-shrink-0">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as PrivacyLevel)}
          className="cursor-pointer appearance-none rounded-lg border border-border bg-bg/60 py-1.5 pl-3 pr-8 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none disabled:opacity-60"
          aria-label={title}
        >
          {PRIVACY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {PRIVACY_LABEL[level]}
            </option>
          ))}
        </select>
        <ChevronDown />
      </div>
    </div>
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
