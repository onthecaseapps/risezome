'use client';

import { useState, useTransition } from 'react';
import { selectAtlassianResourcesAction } from './atlassian-select-action';

interface Resource {
  id: string;
  name: string;
}

/**
 * The Jira-projects + Confluence-spaces checkbox picker. Only not-yet-indexed
 * resources are offered. Submitting upserts a source per resource (of the
 * matching kind) and kicks off indexing. Visibility is owned by the parent
 * (ConnectionSources): inline on first-time setup, and behind a row's ⋮
 * "Manage sources" menu afterwards (with `onDone` to collapse).
 */
export function AtlassianPickers({
  projects,
  spaces,
  onDone,
}: {
  projects: Resource[];
  spaces: Resource[];
  onDone?: (() => void) | undefined;
}): React.ReactElement {
  const [selected, setSelected] = useState<Map<string, 'jira' | 'confluence'>>(new Map());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0 && spaces.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted">
        Every Jira project and Confluence space on this account is already indexed.
      </p>
    );
  }

  function toggle(key: string, kind: 'jira' | 'confluence'): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, kind);
      return next;
    });
  }

  function submit(): void {
    setError(null);
    const all = [
      ...projects.map((p) => ({ key: `jira:${p.id}`, kind: 'jira' as const, res: p })),
      ...spaces.map((s) => ({ key: `confluence:${s.id}`, kind: 'confluence' as const, res: s })),
    ];
    const sel = all
      .filter((x) => selected.has(x.key))
      .map((x) => ({ kind: x.kind, id: x.res.id, name: x.res.name }));
    if (sel.length === 0) return;
    const formData = new FormData();
    formData.set('selection', JSON.stringify(sel));
    startTransition(async () => {
      const res = await selectAtlassianResourcesAction(formData);
      if (!res.ok) setError(res.error);
      else setSelected(new Map());
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {onDone !== undefined ? (
        <div className="mb-3 flex items-center justify-end">
          <button type="button" onClick={onDone} className="text-xs text-muted hover:text-fg">
            Done
          </button>
        </div>
      ) : null}
      {projects.length > 0 ? (
        <ResourceGroup
          label="Jira projects"
          items={projects}
          kind="jira"
          selected={selected}
          onToggle={toggle}
        />
      ) : null}
      {spaces.length > 0 ? (
        <ResourceGroup
          label="Confluence spaces"
          items={spaces}
          kind="confluence"
          selected={selected}
          onToggle={toggle}
        />
      ) : null}
      {error !== null ? <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      <button
        type="button"
        onClick={submit}
        disabled={pending || selected.size === 0}
        className="mt-3 inline-flex items-center rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Adding…' : `Index ${selected.size > 0 ? selected.size : ''} selected`}
      </button>
    </div>
  );
}

function ResourceGroup({
  label,
  items,
  kind,
  selected,
  onToggle,
}: {
  label: string;
  items: Resource[];
  kind: 'jira' | 'confluence';
  selected: Map<string, 'jira' | 'confluence'>;
  onToggle: (key: string, kind: 'jira' | 'confluence') => void;
}): React.ReactElement {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <ul className="flex flex-col gap-1">
        {items.map((r) => {
          const key = `${kind}:${r.id}`;
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent-soft">
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => onToggle(key, kind)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-fg">{r.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
