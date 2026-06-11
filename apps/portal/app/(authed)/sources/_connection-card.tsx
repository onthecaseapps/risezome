'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMenuBehaviors, Modal } from '../_components/overlay';
import { setItemForTeamAction } from './team-source-toggle-action';
import { setConnectionEnabledAction } from './set-connection-enabled-action';
import { reindexSourceAction } from './reindex-action';
import { removeConnectionFromTeamAction } from './remove-connection-action';
import { SourceItemList, type Provider, type SourceItem } from './_source-item-list';
import { useCardFilter, CardFilterPanel, connectorPresetLabel } from './_card-filter-editor';

/**
 * A single connection card (U2): GitHub renders one per installation; Jira,
 * Confluence and Trello render one each.
 *
 * Three independent controls (see the sources-toggle-vs-remove model):
 *   - top toggle  = ENABLE/DISABLE (pause) the source for the team. Immediate,
 *     non-destructive — flips team_sources.enabled; never adds/removes items,
 *     never de-indexes. Paused = kept + indexed but excluded from retrieval.
 *   - checkboxes  = STAGED membership (which spaces/repos). Unchecking is
 *     destructive (de-index if last team) and goes through Save + a confirm.
 *   - kebab Remove = the only full delete.
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
  /** External ids the team currently has (drives the checkboxes' checked state). */
  selectedExternalIds: string[];
  /** Whether the connection is ENABLED (active) for the team vs paused. Drives
   *  the top toggle; independent of which items are selected. */
  enabled: boolean;
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
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useMenuBehaviors(menuOpen, () => setMenuOpen(false));
  // `selected` is the STAGED selection; `savedSelected` is the committed
  // baseline. Nothing indexes/de-indexes until Save reconciles the two — a
  // stray checkbox or master-toggle click no longer takes immediate effect.
  const [savedSelected, setSavedSelected] = useState<Set<string>>(() => new Set(data.selectedExternalIds));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(data.selectedExternalIds));
  // Top-toggle pause state. Immediate + non-destructive (no staging).
  const [enabled, setEnabled] = useState(data.enabled);
  const [togglePending, startToggle] = useTransition();
  const [reindexPending, startReindex] = useTransition();
  const [savePending, startSave] = useTransition();
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removePending, startRemove] = useTransition();
  // Inline note shown when a remove kept some sources (still used by another
  // team). Cleared on the next action.
  const [removeNote, setRemoveNote] = useState<string | null>(null);

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

  function removeConnection(): void {
    startRemove(async () => {
      const res = await removeConnectionFromTeamAction({
        teamId,
        provider: data.provider,
        sourceIds: reindexableSourceIds,
        ...(data.installationId !== undefined ? { installationId: data.installationId } : {}),
      });
      setConfirmRemove(false);
      if (!res.ok) {
        setRemoveNote('Could not remove — please try again.');
        return;
      }
      // This team no longer selects any of this connection's items. Advance the
      // saved baseline too, or `selectionDirty` would immediately fire a phantom
      // "Unsaved changes" bar offering to re-Save the just-removed items.
      setSelected(new Set());
      setSavedSelected(new Set());
      // fullyRemoved → the card vanishes on revalidate; nothing to show. Kept
      // sources mean another team still uses them.
      setRemoveNote(
        res.fullyRemoved
          ? null
          : res.keptInUse > 0
            ? `Removed from this team. ${res.keptInUse} source${res.keptInUse === 1 ? '' : 's'} still used by another team — kept and indexed.`
            : `Removed from this team. ${res.deindexed} de-indexed.`,
      );
    });
  }

  // Source ids the team currently HAS (committed membership) — what the pause
  // toggle acts on. Pause works on saved membership, not staged edits.
  const savedSelectedSourceIds = useMemo(
    () =>
      data.items
        .filter((it) => it.sourceId !== undefined && savedSelected.has(it.externalId))
        .map((it) => it.sourceId as string),
    [data.items, savedSelected],
  );

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
  const filterPillLabel =
    uniqueOverrides.size > 1 ? 'Mixed' : connectorPresetLabel(data.provider, cardPreset);
  const filter = useCardFilter({ provider: data.provider, teamId, sourceIds: cardSourceIds, currentPreset: cardPreset });

  function localSet(externalId: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(externalId);
      else next.delete(externalId);
      return next;
    });
  }

  // Top toggle = ENABLE/DISABLE (pause). Immediate + non-destructive: flips
  // team_sources.enabled for the team's CURRENT members. Never selects items,
  // never indexes/de-indexes. No-op when nothing is selected (the toggle is
  // disabled in that case — there's nothing to pause; add items via the picker).
  function toggleEnabled(): void {
    if (savedSelectedSourceIds.length === 0) return;
    const next = !enabled;
    setEnabled(next); // optimistic
    setSaveNote(null);
    setRemoveNote(null);
    startToggle(async () => {
      const res = await setConnectionEnabledAction({ teamId, sourceIds: savedSelectedSourceIds, enabled: next });
      if (!res.ok) setEnabled(!next); // revert
    });
  }

  // Unsaved selection? (staged differs from the committed baseline.)
  const selectionDirty = useMemo(() => {
    if (selected.size !== savedSelected.size) return true;
    for (const id of selected) if (!savedSelected.has(id)) return true;
    return false;
  }, [selected, savedSelected]);
  const dirty = selectionDirty || filter.dirty;

  // Save button: a destructive change (unchecking a member) can de-index if this
  // is the last team using it — confirm first. Pure adds / filter changes save
  // straight through.
  function requestSave(): void {
    const hasRemovals = [...savedSelected].some((id) => !selected.has(id));
    if (hasRemovals) {
      setConfirmSave(true);
      return;
    }
    doSave();
  }

  function doSave(): void {
    setConfirmSave(false);
    setSaveNote(null);
    setRemoveNote(null);
    const filterWasDirty = filter.dirty;
    startSave(async () => {
      // 1. Apply staged selection diffs through the refcount lifecycle.
      const itemByExternal = new Map(data.items.map((it) => [it.externalId, it]));
      const added = [...selected].filter((id) => !savedSelected.has(id));
      const removed = [...savedSelected].filter((id) => !selected.has(id));
      const calls = [...added.map((id) => ({ id, on: true })), ...removed.map((id) => ({ id, on: false }))].map(
        ({ id, on }) => {
          const it = itemByExternal.get(id);
          return setItemForTeamAction({
            teamId,
            provider: data.provider,
            externalId: id,
            label: it?.label ?? id,
            installationId: it?.installationId,
            on,
          });
        },
      );
      const results = await Promise.all(calls);
      const selectionOk = results.every((r) => r.ok);

      // 2. Apply staged filtering policy only when the selection diffs landed —
      //    don't re-index under a new policy if some adds/removes failed (the
      //    server is already partly mutated; applying policy on top compounds the
      //    divergence). No-op when the filter isn't dirty.
      const filterRes = selectionOk ? await filter.applyPolicy() : { ok: false as const };

      if (selectionOk && filterRes.ok) {
        setSavedSelected(new Set(selected));
        // Describe what actually happened: only adds + filter changes index;
        // removals de-index (no work to wait on).
        const noun = containerNoun(data.provider);
        const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
        const parts: string[] = [];
        if (added.length > 0) parts.push(`indexing ${added.length} new ${plural(added.length)}`);
        if (removed.length > 0) parts.push(`removed ${removed.length} ${plural(removed.length)} from this team`);
        if (filterWasDirty) parts.push('re-indexing with the new filter');
        const indexing = added.length > 0 || filterWasDirty;
        setSaveNote(parts.length > 0 ? `Saved — ${parts.join(', ')}${indexing ? '…' : '.'}` : 'Saved.');
        router.refresh(); // re-fetch so counts/pills/new sources reflect the save
      } else {
        setSaveNote('Some changes could not be saved. Please try again.');
        // Some calls may have applied server-side; re-sync to the real state so
        // a retry diffs against truth instead of re-issuing applied changes.
        router.refresh();
      }
    });
  }

  function discardAll(): void {
    setSelected(new Set(savedSelected));
    filter.discard();
    setSaveNote(null);
    setRemoveNote(null);
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
          <div className="mt-0.5 text-xs text-muted">
            {!enabled && savedSelectedSourceIds.length > 0 ? (
              <span className="font-medium text-amber-600">Paused · </span>
            ) : null}
            {statusLine}
          </div>
          {removeNote !== null ? (
            <div className="mt-0.5 text-xs text-amber-600">{removeNote}</div>
          ) : null}
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
            checked={enabled}
            disabled={togglePending || savedSelectedSourceIds.length === 0}
            onChange={toggleEnabled}
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
              <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden whitespace-nowrap rounded-lg border border-border bg-card shadow-[var(--shadow-pop)]">
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
                ) : null}
                <div className="border-t border-border" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setRemoveNote(null);
                    setConfirmRemove(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-500/10"
                >
                  <TrashIcon />
                  Remove source
                </button>
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
        <div className="overflow-hidden">
          {cardSourceIds.length > 0 ? (
            <div className="border-t border-border px-4 py-4">
              <CardFilterPanel f={filter} disabled={savePending} />
            </div>
          ) : null}
          <SourceItemList
            provider={data.provider}
            items={data.items}
            selectedKeys={selected}
            onSelectionChange={localSet}
            disabled={savePending}
          />
        </div>
      ) : null}

      {/* Unified save/discard bar — shown for ANY staged change (selection or
          filtering), so nothing takes effect on a stray click. Lives at the
          card root so it's visible even when collapsed (the master toggle can
          stage while collapsed). */}
      {dirty || saveNote !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-border bg-accent-soft/50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            {dirty ? (
              <>
                <span className="h-2 w-2 flex-none rounded-full bg-accent" />
                <span className="font-medium text-accent">Unsaved changes</span>
                <span className="text-xs text-muted">Saving applies them and indexes affected sources.</span>
              </>
            ) : saveNote !== null ? (
              <span className="text-xs text-muted">{saveNote}</span>
            ) : null}
          </div>
          {dirty ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={savePending}
                onClick={discardAll}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={savePending}
                onClick={requestSave}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {savePending ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {confirmSave ? (
        <Modal onClose={() => (savePending ? undefined : setConfirmSave(false))} ariaLabel="Confirm save">
          <h2 className="text-base font-semibold text-fg">Save changes?</h2>
          <p className="mt-2 text-sm text-muted">
            You&rsquo;re removing {[...savedSelected].filter((id) => !selected.has(id)).length}{' '}
            {containerNoun(data.provider)}
            {[...savedSelected].filter((id) => !selected.has(id)).length === 1 ? '' : 's'} from this team. Any no longer
            used by another team will be removed from the index. Items you&rsquo;re keeping are unaffected.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={savePending}
              onClick={() => setConfirmSave(false)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={savePending}
              onClick={doSave}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {savePending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      ) : null}

      {confirmRemove ? (
        <Modal onClose={() => (removePending ? undefined : setConfirmRemove(false))} ariaLabel={`Remove ${data.name}`}>
          <h2 className="text-base font-semibold text-fg">Remove {data.name}?</h2>
          <p className="mt-2 text-sm text-muted">
            This removes {data.name} from this team. Sources no longer used by any team are
            de-indexed and the connection is disconnected. Anything still used by another team is
            kept and stays indexed.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={removePending}
              onClick={() => setConfirmRemove(false)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={removePending}
              onClick={removeConnection}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {removePending ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
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
  const container = containerNoun(data.provider);
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

/** The provider's per-item container noun (repo / board / project / space). */
function containerNoun(provider: Provider): string {
  return provider === 'github' ? 'repo' : provider === 'trello' ? 'board' : provider === 'jira' ? 'project' : 'space';
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
  // Enable/disable (pause) the whole source for the team. On = active in
  // retrieval; off = paused (kept + indexed, not retrieved). Disabled when the
  // team has nothing selected (nothing to pause — add items via the picker).
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Enable or disable this source for the team"
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

function TrashIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
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
