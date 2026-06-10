'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { useMenuBehaviors } from '../_components/overlay';
import { setItemForTeamAction } from './team-source-toggle-action';
import { reindexSourceAction } from './reindex-action';
import { SourceItemList, type Provider, type SourceItem } from './_source-item-list';
import { CardFilterEditor } from './_card-filter-editor';

/**
 * A single connection card (U2): GitHub renders one per installation; Jira,
 * Confluence and Trello render one each. The card shows the connection's icon,
 * name + account/site badge, a connected/indexed status line, a master toggle
 * (bulk add/remove all of this connection's items for the selected team), a
 * kebab (manage on the provider), and an expand/collapse that reveals the
 * per-item checklist (SourceItemList, U3).
 */
export interface ConnectionCardData {
  provider: Provider;
  /** Stable key (installation id for GitHub, kind for others). */
  cardKey: string;
  /** Display name: "GitHub", "Jira", "Confluence", "Trello". */
  name: string;
  /** Account / site badge: github account_login, atlassian site, trello workspace. */
  badge: string | null;
  icon: ReactElement;
  /** True if the provider connection is suspended (GitHub) / degraded. */
  suspended?: boolean;
  /** External management URL (GitHub installation settings) or connect route. */
  manageUrl: string | null;
  items: SourceItem[];
  /** External ids selected for the team (drives checked state + master toggle). */
  selectedExternalIds: string[];
  installationId?: number;
  /** Workspace default filtering preset (for the "Inherit" option label). */
  orgDefaultPreset?: string;
}

export function ConnectionCard({
  teamId,
  data,
}: {
  teamId: string;
  data: ConnectionCardData;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useMenuBehaviors(menuOpen, () => setMenuOpen(false));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(data.selectedExternalIds));
  const [bulkPending, startBulk] = useTransition();
  const [reindexPending, startReindex] = useTransition();

  // Source ids for this connection's items that actually have a source row;
  // available-but-unindexed items have no source and can't be reindexed.
  const reindexableSourceIds = useMemo(
    () => data.items.map((it) => it.sourceId).filter((id): id is string => id !== undefined),
    [data.items],
  );

  function reindexConnection(mode: 'delta' | 'full'): void {
    setMenuOpen(false);
    if (reindexableSourceIds.length === 0) return;
    startReindex(async () => {
      await Promise.all(
        reindexableSourceIds.map((sourceId) => {
          const fd = new FormData();
          fd.set('sourceId', sourceId);
          fd.set('mode', mode);
          return reindexSourceAction(fd);
        }),
      );
    });
  }

  const allSelected = data.items.length > 0 && data.items.every((it) => selected.has(it.externalId));

  // Card-level filtering: applies to every source under this connection. The
  // representative preset is the common per-source override, or null (inherit).
  const cardSourceIds = useMemo(
    () => data.items.map((it) => it.sourceId).filter((id): id is string => id !== undefined),
    [data.items],
  );
  const overridePresets = useMemo(
    () => data.items.filter((it) => it.sourceId !== undefined).map((it) => it.presetKey ?? null),
    [data.items],
  );
  const uniqueOverrides = new Set(overridePresets);
  const cardPreset = uniqueOverrides.size === 1 ? (overridePresets[0] ?? null) : null;
  const orgDefaultPreset = data.orgDefaultPreset ?? 'recommended';
  const filterPillLabel =
    uniqueOverrides.size > 1 ? 'Mixed' : cardPreset === null ? presetLabel(orgDefaultPreset) : presetLabel(cardPreset);

  function localSet(externalId: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(externalId);
      else next.delete(externalId);
      return next;
    });
  }

  function masterToggle(): void {
    const turnOn = !allSelected;
    // Trello: don't bulk-add every board on turn-on. Boards are individually
    // meaningful and auto-indexing all of them is rarely wanted (and costly), so
    // turning Trello "on" opens the board picker instead — the user chooses which
    // boards to index. Other providers keep the select-all/none master toggle.
    if (turnOn && data.provider === 'trello') {
      setExpanded(true);
      return;
    }
    // Targets: items that need flipping to reach the desired state.
    const targets = data.items.filter((it) => selected.has(it.externalId) !== turnOn);
    // Optimistically reflect the new state.
    setSelected(turnOn ? new Set(data.items.map((it) => it.externalId)) : new Set());
    startBulk(async () => {
      await Promise.all(
        targets.map((it) =>
          setItemForTeamAction({
            teamId,
            provider: data.provider,
            externalId: it.externalId,
            label: it.label,
            installationId: it.installationId,
            on: turnOn,
          }),
        ),
      );
    });
  }

  const statusLine = useMemo(() => buildStatusLine(data, selected.size), [data, selected.size]);

  return (
    <div className={`rounded-xl border bg-card shadow-[var(--card-shadow)] ${data.suspended === true ? 'border-amber-500/40' : 'border-border'}`}>
      <div className="flex items-center gap-4 p-4">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-bg">
          {data.icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{data.name}</span>
            {data.badge !== null ? (
              <span className="truncate rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] font-medium text-muted">
                {data.badge}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-muted">{statusLine}</div>
        </div>

        <div className="relative flex flex-shrink-0 items-center gap-2">
          {cardSourceIds.length > 0 ? (
            <span
              className="hidden items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] font-medium text-muted sm:inline-flex"
              title="Active corpus filtering. Expand to change."
            >
              <FilterIcon />
              {filterPillLabel}
            </span>
          ) : null}
          <MasterToggle
            checked={allSelected}
            disabled={bulkPending || data.items.length === 0}
            onChange={masterToggle}
          />

          <button
            type="button"
            aria-label="Connection actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-md p-1.5 text-muted hover:bg-bg"
          >
            <KebabIcon />
          </button>
          {menuOpen ? (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-pop)]">
                {reindexableSourceIds.length > 0 ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={reindexPending}
                      onClick={() => reindexConnection('delta')}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-default disabled:opacity-50"
                    >
                      <RefreshIcon />
                      Reindex (delta)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={reindexPending}
                      onClick={() => reindexConnection('full')}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-default disabled:opacity-50"
                    >
                      <RefreshIcon />
                      Reindex (full)
                    </button>
                  </>
                ) : null}
                {data.manageUrl !== null ? (
                  <a
                    role="menuitem"
                    href={data.manageUrl}
                    target={data.manageUrl.startsWith('http') ? '_blank' : undefined}
                    rel={data.manageUrl.startsWith('http') ? 'noopener noreferrer' : undefined}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg"
                    onClick={() => setMenuOpen(false)}
                  >
                    <GearIcon />
                    Manage on {data.name}
                  </a>
                ) : reindexableSourceIds.length === 0 ? (
                  <span className="block px-3 py-2 text-sm text-muted">No actions available</span>
                ) : null}
              </div>
            </>
          ) : null}

          <button
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md p-1.5 text-muted hover:bg-bg"
          >
            <ChevronIcon up={expanded} />
          </button>
        </div>
      </div>

      {expanded ? (
        // Scope the rounded-corner clip to the expandable list so the card root
        // can stay overflow-visible — otherwise it clips the kebab dropdown.
        <div className="overflow-hidden rounded-b-xl">
          {cardSourceIds.length > 0 ? (
            <div className="border-t border-border px-4 py-4">
              <CardFilterEditor
                provider={data.provider}
                sourceIds={cardSourceIds}
                currentPreset={cardPreset}
                orgDefaultPreset={orgDefaultPreset}
              />
            </div>
          ) : null}
          <SourceItemList
            provider={data.provider}
            teamId={teamId}
            items={data.items}
            selectedKeys={selected}
            onSelectionChange={localSet}
          />
        </div>
      ) : null}
    </div>
  );
}

function presetLabel(key: string): string {
  return key === 'index_everything'
    ? 'Index everything'
    : key === 'code_only'
      ? 'Code only'
      : key === 'recommended'
        ? 'Recommended'
        : key === 'custom'
          ? 'Custom'
          : key;
}

function FilterIcon(): ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function buildStatusLine(data: ConnectionCardData, selectedCount: number): string {
  if (data.suspended === true) return 'Suspended — indexing paused';
  const indexing = data.items.filter((it) => it.status === 'indexing');
  if (indexing.length > 0) {
    const done = indexing.reduce((s, it) => s + (it.count ?? 0), 0);
    const total = indexing.reduce((s, it) => s + (it.total ?? 0), 0);
    return total > 0 ? `Connected · Indexing ${done.toLocaleString()}/${total.toLocaleString()}` : 'Connected · Indexing…';
  }
  const indexed = data.items
    .filter((it) => it.status !== null && it.status !== 'removed')
    .reduce((s, it) => s + (it.count ?? 0), 0);
  const noun = data.provider === 'github' ? 'files' : data.provider === 'trello' ? 'cards' : data.provider === 'jira' ? 'issues' : 'pages';
  const container =
    data.provider === 'github' ? 'repo' : data.provider === 'trello' ? 'board' : data.provider === 'jira' ? 'project' : 'space';
  const total = data.items.length;
  const parts: string[] = [];
  if (total > 0) {
    parts.push(`${selectedCount} of ${total} ${container}${total === 1 ? '' : 's'} connected`);
  }
  if (indexed > 0) parts.push(`${indexed.toLocaleString()} ${noun} indexed`);
  // Exclusion visibility (R4): never silently drop content — show how many
  // candidates the active policy excluded so a customer can recover via the
  // preset selector or an "Index everything" override.
  const excluded = data.items
    .filter((it) => it.status !== null && it.status !== 'removed')
    .reduce((s, it) => s + (it.excluded ?? 0), 0);
  if (excluded > 0) parts.push(`${excluded.toLocaleString()} excluded by policy`);
  return parts.length > 0 ? parts.join(' · ') : 'Connected';
}

function MasterToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}): ReactElement {
  // Deliberately binary: on only when ALL items are selected. A partial
  // selection reads from the "X of Y connected" status line instead — the
  // earlier three-position knob looked broken, not indeterminate.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Select all items for this team"
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-border'
      } ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function KebabIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function GearIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: up ? 'rotate(180deg)' : undefined }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
