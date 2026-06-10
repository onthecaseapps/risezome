'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { setItemForTeamAction } from './team-source-toggle-action';

/**
 * Provider-agnostic per-item checklist inside an expanded connection card (U3).
 *
 * Each item is a repo / Jira project / Confluence space / Trello board,
 * normalized to the same shape regardless of provider. The checkbox's checked
 * state = the item's source is in the selected team's `team_sources`. An
 * All|Selected tab, a filter box, and per-item counts / indexing progress sit on
 * top. Toggling calls setItemForTeamAction (U4) — ensure-source + the refcount
 * lifecycle — with optimistic local state reverted on failure.
 */
export type Provider = 'github' | 'trello' | 'jira' | 'confluence';

export interface SourceItem {
  /** Stable client key: the source id when one exists, else the external id. */
  key: string;
  /**
   * The `sources` row id, when this item already has one. Present for every
   * GitHub repo and for any indexed Trello/Jira/Confluence item; absent for
   * available-but-unindexed items. Drives connection-level reindex (only items
   * with a source can be reindexed).
   */
  sourceId?: string;
  /** GitHub: repo_full_name. Trello/Jira/Confluence: external id. */
  externalId: string;
  label: string;
  /** Indexed item count (files / cards / issues / pages) when known. */
  count: number | null;
  /** Total items, when indexing and a denominator is known (drives progress). */
  total: number | null;
  /** Indexer status for this item's source, if a source row exists. */
  status: string | null;
  /** Candidates the corpus policy excluded on the last index run (R4 visibility). */
  excluded?: number | undefined;
  /** This source's override preset, when set; null/undefined = inherit org default. */
  presetKey?: string | null | undefined;
  /** GitHub only: the installation this repo belongs to. */
  installationId?: number | undefined;
}

const ITEM_NOUN: Record<Provider, string> = {
  github: 'file',
  trello: 'card',
  jira: 'issue',
  confluence: 'page',
};

export function SourceItemList({
  provider,
  teamId,
  items,
  selectedKeys,
  onSelectionChange,
}: {
  provider: Provider;
  teamId: string;
  items: SourceItem[];
  /** Keys (externalId) currently selected for the team. */
  selectedKeys: Set<string>;
  /** Notifies the parent card of a local selection change (master-toggle sync). */
  onSelectionChange?: (externalId: string, on: boolean) => void;
}): ReactElement {
  const [tab, setTab] = useState<'all' | 'selected'>('all');
  const [query, setQuery] = useState('');
  // Local mirror of selection so optimistic toggles re-render this list.
  const [localSelected, setLocalSelected] = useState<Set<string>>(() => new Set(selectedKeys));

  function applyLocal(externalId: string, on: boolean): void {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(externalId);
      else next.delete(externalId);
      return next;
    });
    onSelectionChange?.(externalId, on);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (tab === 'selected' && !localSelected.has(it.externalId)) return false;
      if (q.length > 0 && !it.label.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, tab, query, localSelected]);

  const selectedCount = localSelected.size;

  return (
    <div className="border-t border-border bg-bg/30 px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => setTab('all')}
            className={`rounded-md px-2.5 py-1 ${tab === 'all' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
          >
            All {labelFor(provider)}
          </button>
          <button
            type="button"
            onClick={() => setTab('selected')}
            className={`rounded-md px-2.5 py-1 ${tab === 'selected' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
          >
            Selected
          </button>
        </div>
        <span className="text-xs text-muted">
          {selectedCount} of {items.length} selected
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter"
          className="w-40 rounded-lg border border-border bg-bg/60 px-3 py-1.5 text-xs text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-muted">
          {tab === 'selected' ? 'Nothing selected yet.' : query.length > 0 ? 'No matches.' : 'Nothing to show.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {filtered.map((it) => (
            <ItemRow
              key={it.key}
              provider={provider}
              teamId={teamId}
              item={it}
              checked={localSelected.has(it.externalId)}
              onToggle={applyLocal}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemRow({
  provider,
  teamId,
  item,
  checked,
  onToggle,
}: {
  provider: Provider;
  teamId: string;
  item: SourceItem;
  checked: boolean;
  onToggle: (externalId: string, on: boolean) => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(): void {
    const next = !checked;
    onToggle(item.externalId, next); // optimistic
    setError(null);
    start(async () => {
      const result = await setItemForTeamAction({
        teamId,
        provider,
        externalId: item.externalId,
        label: item.label,
        installationId: item.installationId,
        on: next,
      });
      if (!result.ok) {
        onToggle(item.externalId, !next); // revert
        setError(itemErrorMessage(result.error));
      }
    });
  }

  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent-soft/40">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={toggle}
          aria-label={`${item.label} for team`}
          className="h-4 w-4 flex-none accent-[var(--accent)] disabled:opacity-50"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{item.label}</span>
          {error !== null ? <span role="alert" className="block text-[11px] text-error">{error}</span> : null}
        </span>
        <ItemMeta provider={provider} item={item} />
      </label>
    </li>
  );
}

function ItemMeta({ provider, item }: { provider: Provider; item: SourceItem }): ReactElement | null {
  const noun = ITEM_NOUN[provider];
  if (item.status === 'indexing') {
    const pct = item.total !== null && item.total > 0
      ? Math.min(100, Math.round(((item.count ?? 0) / item.total) * 100))
      : 0;
    return (
      <span className="flex flex-none items-center gap-2 text-[11px] text-accent">
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
          <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
        </span>
        {(item.count ?? 0).toLocaleString()}
        {item.total !== null ? `/${item.total.toLocaleString()}` : ''}
      </span>
    );
  }
  if (item.count !== null) {
    return (
      <span className="flex-none text-[11px] text-muted">
        {item.count.toLocaleString()} {item.count === 1 ? noun : `${noun}s`}
      </span>
    );
  }
  return null;
}

function labelFor(provider: Provider): string {
  if (provider === 'github') return 'repositories';
  if (provider === 'trello') return 'boards';
  if (provider === 'jira') return 'projects';
  return 'spaces';
}

function itemErrorMessage(error: string): string {
  if (error === 'source_not_found') return 'Not found — re-grant access on the provider.';
  if (error === 'trello_not_connected') return 'Trello is not connected.';
  if (error === 'atlassian_not_connected') return 'Jira/Confluence is not connected.';
  return 'Could not update. Try again.';
}
