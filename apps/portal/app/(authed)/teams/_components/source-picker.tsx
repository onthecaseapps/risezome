'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { addTeamSourceAction, removeTeamSourceAction } from '../source-actions';
import type { TeamSourceRow } from './teams-client';

/**
 * Per-team source curation. Lists the org's selectable sources with a toggle:
 * on = the source is selected for this team (a row in team_sources). Toggling
 * calls add/removeTeamSourceAction — which delegate to the U3 refcount lifecycle
 * (first selection indexes; last de-selection de-indexes). Optimistic local
 * state, reverted on failure, reconciled by the action's revalidatePath('/teams').
 */
export function SourcePicker({
  teamId,
  sources,
  initialSourceIds,
}: {
  teamId: string;
  sources: TeamSourceRow[];
  initialSourceIds: string[];
}): ReactElement {
  const [sourceIds, setSourceIds] = useState<Set<string>>(() => new Set(initialSourceIds));
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return sources;
    return sources.filter((s) => `${s.label} ${s.kind}`.toLowerCase().includes(q));
  }, [sources, query]);

  function setSelection(sourceId: string, on: boolean): void {
    setSourceIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-card/40 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">Sources · {sourceIds.size}</h3>
        {sources.length > 0 ? (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-44 rounded-lg border border-border bg-bg/60 px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
          />
        ) : null}
      </div>
      {sources.length === 0 ? (
        <p className="rounded-xl border border-border bg-card/20 px-4 py-6 text-center text-sm text-muted">
          No sources connected yet. Connect repos, boards, or projects under{' '}
          <a href="/sources" className="text-accent hover:underline">Sources</a>.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {filtered.map((s) => (
            <SourceRow
              key={s.id}
              teamId={teamId}
              source={s}
              on={sourceIds.has(s.id)}
              onToggle={setSelection}
            />
          ))}
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted">No sources match “{query}”.</li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function SourceRow({
  teamId,
  source,
  on,
  onToggle,
}: {
  teamId: string;
  source: TeamSourceRow;
  on: boolean;
  onToggle: (sourceId: string, on: boolean) => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(): void {
    const next = !on;
    onToggle(source.id, next); // optimistic
    setError(null);
    start(async () => {
      const result = next
        ? await addTeamSourceAction(teamId, source.id)
        : await removeTeamSourceAction(teamId, source.id);
      if (!result.ok) {
        onToggle(source.id, !next); // revert
        setError(sourceErrorMessage(result.error));
      }
    });
  }

  return (
    <li className="flex items-center gap-3 bg-card/20 px-4 py-3">
      <span className="rounded-md border border-border bg-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
        {source.kind}
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{source.label}</span>
        {error !== null ? <p role="alert" className="text-xs text-error">{error}</p> : null}
      </div>
      <Toggle checked={on} disabled={pending} onChange={toggle} label={`${source.label} on team`} />
    </li>
  );
}

function sourceErrorMessage(error: string): string {
  if (error === 'source_not_found') return 'Source not found in this workspace.';
  return 'Could not update the source. Try again.';
}

function Toggle({
  checked,
  disabled = false,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-border'
      } ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
