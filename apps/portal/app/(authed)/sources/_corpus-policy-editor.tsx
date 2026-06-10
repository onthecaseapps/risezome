'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { setOrgCorpusPolicyAction } from './corpus-policy-action';

const PRESET_LABELS: Record<string, string> = {
  recommended: 'Recommended (exclude tests, fixtures, build config)',
  index_everything: 'Index everything',
  code_only: 'Code only (also exclude docs)',
};

/**
 * Org-default corpus-policy selector (U6). Admin-only; changing it reindexes
 * every source that has no per-source override so the new policy's exclusions
 * are applied + pruned. Per-source overrides are a follow-up (see plan scope).
 */
export function CorpusPolicyEditor({ currentPreset }: { currentPreset: string }): ReactElement {
  const [preset, setPreset] = useState(currentPreset);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  function onChange(next: string): void {
    setPreset(next);
    setNote(null);
    startTransition(async () => {
      const res = await setOrgCorpusPolicyAction(next);
      if (res.ok) {
        setNote(res.reindexed > 0 ? `Reindexing ${String(res.reindexed)} source${res.reindexed === 1 ? '' : 's'}…` : 'Saved.');
      } else {
        setNote(`Couldn't save: ${res.error}`);
        setPreset(currentPreset); // revert optimistic value
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="corpus-preset" className="font-medium text-fg">
        Default filtering
      </label>
      <select
        id="corpus-preset"
        value={preset}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-card px-2 py-1 text-sm text-fg disabled:opacity-50"
      >
        {Object.entries(PRESET_LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      {note !== null ? <span className="text-xs text-muted">{note}</span> : null}
    </div>
  );
}
