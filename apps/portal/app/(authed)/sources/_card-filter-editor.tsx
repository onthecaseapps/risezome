'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { useMenuBehaviors } from '../_components/overlay';
import { setTeamSourcePolicyAction } from './corpus-policy-action';
import { getTrelloListsAction } from './trello-lists-action';
import type { Provider } from './_source-item-list';

/**
 * Per-connection corpus-filtering editor (F4), matching the Sources Filtering
 * mockup: a preset dropdown + an "EXCLUDED BY THIS PRESET" chip box, and a
 * Custom mode with editable removable chips + a dashed "Add …" input, plus
 * connector-specific controls (Trello completed-cards / lists; age cutoffs).
 * Applies the chosen policy to every source under the connection and reindexes.
 */

const AGE_DAYS = { days: 1, months: 30, years: 365 } as const;
type AgeUnit = keyof typeof AGE_DAYS;

interface Opt {
  value: string;
  label: string;
  desc: string;
}

// Per-connector preset menus (labels/copy from the mockup). Each value maps to
// a backend policy in buildPolicyForOption / buildCustomPolicy.
const OPTIONS: Record<Provider, Opt[]> = {
  github: [
    { value: 'recommended', label: 'Recommended', desc: 'Excludes tests, fixtures, lockfiles & build output' },
    { value: 'code', label: 'Code only', desc: 'Only source code — skips docs, configs & data' },
    { value: 'everything', label: 'Everything', desc: 'Indexes every file in the repository' },
    { value: 'custom', label: 'Custom…', desc: 'Define your own exclude patterns' },
  ],
  trello: [
    { value: 'active', label: 'Exclude completed & archived', desc: 'Skips archived boards and cards in Done lists' },
    { value: 'everything', label: 'Everything', desc: 'Indexes all cards, including completed & archived' },
    { value: 'custom', label: 'Custom…', desc: 'Exclude specific lists or stale cards' },
  ],
  jira: [
    { value: 'active', label: 'Exclude done & archived', desc: 'Skips Done, Closed and Resolved issues' },
    { value: 'everything', label: 'Everything', desc: 'Indexes every issue, including completed' },
    { value: 'custom', label: 'Custom…', desc: 'Exclude specific statuses, types or stale issues' },
  ],
  confluence: [
    { value: 'recommended', label: 'Recommended', desc: 'Indexes current pages (drafts & archived are skipped)' },
    { value: 'custom', label: 'Custom…', desc: 'Also exclude stale pages by age' },
  ],
};

// Representative chips shown in the "EXCLUDED BY THIS PRESET" box for the
// non-custom options.
const PRESET_CHIPS: Record<Provider, Record<string, string[]>> = {
  github: {
    recommended: ['**/*.test.*', '**/fixtures/**', 'dist/**', 'build/**', '*.lock', '**/*.min.*'],
    code: ['**/*.test.*', 'dist/**', '*.lock', '*.md', '*.mdx'],
    everything: [],
  },
  trello: { active: ['archived cards', 'Done-list cards'], everything: [] },
  jira: { active: ['Done', 'Closed', 'Resolved', 'Cancelled', "Won't Do"], everything: [] },
  confluence: { recommended: ['drafts', 'archived pages'] },
};

const CHIP_LABEL_FONT_MONO: Record<Provider, boolean> = { github: true, trello: false, jira: false, confluence: false };

// Entering Custom seeds the chips from the recommended defaults so the user
// starts from a working example and tweaks. Only for connectors whose chips
// are literal rule values (paths, statuses); Trello/Confluence preset chips are
// descriptive, not literal, so they seed empty.
const CUSTOM_SEED: Record<Provider, string[]> = {
  github: ['**/*.test.*', '**/fixtures/**', 'dist/**', 'build/**', '*.lock', '**/*.min.*'],
  jira: ['Done', 'Closed', 'Resolved', 'Cancelled', "Won't Do"],
  trello: [],
  confluence: [],
};

export interface CustomState {
  patterns: string[]; // github globs / jira statuses / trello lists (excluded, or include-only for github)
  draft: string;
  /** GitHub: whether `patterns` are exclude globs or an only-index allowlist. */
  githubMode: 'exclude' | 'include';
  jiraTypes: string[];
  jiraTypeDraft: string;
  trelloIncludeArchived: boolean;
  ageValue: string;
  ageUnit: AgeUnit;
}

const EMPTY_CUSTOM: CustomState = {
  patterns: [],
  draft: '',
  githubMode: 'exclude',
  jiraTypes: [],
  jiraTypeDraft: '',
  trelloIncludeArchived: false,
  ageValue: '',
  ageUnit: 'months',
};

/** A named (non-custom) option → stored CorpusPolicy (or null to inherit). */
function buildPolicyForOption(provider: Provider, value: string): Record<string, unknown> {
  if (value === 'everything') {
    return provider === 'trello'
      ? { preset: 'recommended', connectorOptions: { trello: { includeArchived: true } } }
      : { preset: 'index_everything' };
  }
  if (provider === 'github' && value === 'code') return { preset: 'code_only' };
  // recommended / active (jira & trello already drop closed/archived) → recommended.
  return { preset: 'recommended' };
}

function ageRule(provider: Provider, c: CustomState): Record<string, unknown> | null {
  if (c.ageValue.trim() === '') return null;
  const days = Number(c.ageValue) * AGE_DAYS[c.ageUnit];
  if (!Number.isFinite(days) || days <= 0) return null;
  return { source: provider, field: 'updatedBefore', op: 'olderThanDays', value: days };
}

export function buildCustomPolicy(provider: Provider, c: CustomState): Record<string, unknown> {
  const policy: Record<string, unknown> = { preset: 'recommended' };
  const rules: Array<Record<string, unknown>> = [];
  const age = ageRule(provider, c);

  if (provider === 'github') {
    if (c.patterns.length > 0) {
      if (c.githubMode === 'include') policy['customIncludeOnly'] = c.patterns;
      else policy['customExcludes'] = c.patterns;
    }
  }
  if (provider === 'jira') {
    if (c.patterns.length > 0) rules.push({ source: 'jira', field: 'status', op: 'in', value: c.patterns });
    if (c.jiraTypes.length > 0) rules.push({ source: 'jira', field: 'issueType', op: 'in', value: c.jiraTypes });
    if (age) rules.push(age);
  }
  if (provider === 'trello') {
    policy['connectorOptions'] = { trello: { includeArchived: c.trelloIncludeArchived } };
    if (c.patterns.length > 0) rules.push({ source: 'trello', field: 'list', op: 'in', value: c.patterns });
    if (age) rules.push(age);
  }
  if (provider === 'confluence') {
    if (age) rules.push(age);
  }
  if (rules.length > 0) policy['connectorRules'] = rules;
  return policy;
}

export interface CardFilter {
  provider: Provider;
  hasSources: boolean;
  dirty: boolean;
  /** Persist the current policy to the connection's sources. Resolves with the
   *  reindex count, or an error. A no-op (ok, reindexed 0) when not dirty. The
   *  card owns the save transition + notice; this just runs the action. */
  applyPolicy: () => Promise<{ ok: boolean; reindexed?: number; error?: string }>;
  discard: () => void;
  // panel-only internals
  opts: Opt[];
  mode: string;
  selectedDesc: string;
  onMode: (v: string) => void;
  c: CustomState;
  setC: (c: CustomState) => void;
  chips: string[];
  mono: boolean;
  ageNoun: string;
  githubInclude: boolean;
  trelloToggleLists: boolean;
  customHeader: string;
  addPlaceholder: string;
  trelloLists: string[] | null | undefined;
  toggleList: (l: string) => void;
  setGithubMode: (m: 'exclude' | 'include') => void;
}

/** Owns all per-connection filter state so the panel (above the repo list) and
 *  the footer (below it) can share it. */
export function useCardFilter({
  provider,
  teamId,
  sourceIds,
  currentPreset,
}: {
  provider: Provider;
  /** The team whose VIEW policy this editor writes (query-time filtering). */
  teamId: string;
  sourceIds: string[];
  currentPreset: string | null;
}): CardFilter {
  const opts = OPTIONS[provider];
  // Map the stored preset back to a menu value for the initial selection.
  const initial = mapPresetToOption(provider, currentPreset);
  const [mode, setMode] = useState<string>(initial);
  // The persisted selection. Editing stages changes; nothing reindexes until
  // Save. Discard reverts to this.
  const [savedMode, setSavedMode] = useState<string>(initial);
  const [c, setC] = useState<CustomState>(EMPTY_CUSTOM);
  // Trello: lazily-fetched board list names for togglable exclusion.
  // undefined = not loaded, null = load failed/empty (fall back to free-text).
  const [trelloLists, setTrelloLists] = useState<string[] | null | undefined>(undefined);

  useEffect(() => {
    if (provider !== 'trello' || mode !== 'custom' || trelloLists !== undefined) return;
    let live = true;
    void getTrelloListsAction(sourceIds).then((res) => {
      if (!live) return;
      setTrelloLists(res.ok && res.lists.length > 0 ? res.lists : null);
    });
    return () => {
      live = false;
    };
  }, [provider, mode, trelloLists, sourceIds]);

  const selected = opts.find((o) => o.value === mode) ?? opts[0]!;
  const chips = mode === 'custom' ? c.patterns : PRESET_CHIPS[provider][mode] ?? [];
  const mono = CHIP_LABEL_FONT_MONO[provider];
  const customNoun = provider === 'github' ? 'pattern' : provider === 'jira' ? 'status' : provider === 'trello' ? 'list' : 'item';
  const ageNoun = provider === 'jira' ? 'issues' : provider === 'trello' ? 'cards' : 'pages';

  const customHasContent =
    c.patterns.length > 0 || c.jiraTypes.length > 0 || c.ageValue.trim() !== '' || c.trelloIncludeArchived;
  const dirty = mode !== savedMode || (mode === 'custom' && customHasContent);

  const githubInclude = provider === 'github' && c.githubMode === 'include';
  const trelloToggleLists = provider === 'trello' && mode === 'custom' && Array.isArray(trelloLists);
  const customHeader = githubInclude ? 'Only index these paths · editable' : `Exclude ${customNoun}s · editable`;
  const addPlaceholder = githubInclude
    ? 'Add a path to index and press Enter, e.g. packages/api/**'
    : provider === 'github'
      ? 'Add a pattern and press Enter, e.g. vendor/**'
      : provider === 'jira'
        ? 'Add a status and press Enter, e.g. In Review'
        : 'Add a list and press Enter, e.g. Icebox';

  function toggleList(list: string): void {
    setC({ ...c, patterns: c.patterns.includes(list) ? c.patterns.filter((l) => l !== list) : [...c.patterns, list] });
  }

  function setGithubMode(next: 'exclude' | 'include'): void {
    setC({ ...c, githubMode: next, patterns: next === 'exclude' ? [...CUSTOM_SEED.github] : [] });
  }

  function onMode(next: string): void {
    // Staged only — no reindex until Save. Entering Custom seeds the recommended
    // defaults as a starting example (unless the user already has chips).
    if (next === 'custom' && c.patterns.length === 0) {
      setC({ ...c, patterns: [...CUSTOM_SEED[provider]] });
    }
    setMode(next);
  }

  async function applyPolicy(): Promise<{ ok: boolean; reindexed?: number; error?: string }> {
    if (!dirty) return { ok: true, reindexed: 0 };
    const policy = mode === 'custom' ? buildCustomPolicy(provider, c) : buildPolicyForOption(provider, mode);
    const res = await setTeamSourcePolicyAction(teamId, sourceIds, policy as never);
    if (res.ok) {
      setSavedMode(mode);
      return { ok: true, reindexed: res.reindexed };
    }
    return { ok: false, error: res.error };
  }

  function discard(): void {
    setMode(savedMode);
    setC(EMPTY_CUSTOM);
  }

  return {
    provider,
    hasSources: sourceIds.length > 0,
    dirty,
    applyPolicy,
    discard,
    opts,
    mode,
    selectedDesc: selected.desc,
    onMode,
    c,
    setC,
    chips,
    mono,
    ageNoun,
    githubInclude,
    trelloToggleLists,
    customHeader,
    addPlaceholder,
    trelloLists,
    toggleList,
    setGithubMode,
  };
}

/**
 * Preset selector dropdown. A native <select> can only render the option label,
 * but the mockup wants each option's short description on a second line (and a
 * check on the active one), so this is a custom listbox: a button showing the
 * current label + a menu of two-line label/description rows.
 */
function PresetDropdown({
  opts,
  value,
  disabled,
  onChange,
}: {
  opts: Opt[];
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  useMenuBehaviors(open, () => setOpen(false));
  const selected = opts.find((o) => o.value === value) ?? opts[0]!;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-fg hover:bg-bg disabled:opacity-50"
      >
        <span>{selected.label}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="listbox"
            aria-label="Filtering preset"
            className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-[var(--shadow-pop)]"
          >
            {opts.map((o) => {
              const isSel = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`block w-full px-3 py-2 text-left hover:bg-bg ${isSel ? 'bg-accent-soft' : ''}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-semibold ${isSel ? 'text-accent' : 'text-fg'}`}>{o.label}</span>
                    {isSel ? <CheckIcon /> : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{o.desc}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none text-accent">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** The filter editor body (dropdown + chip box), rendered above the repo list. */
export function CardFilterPanel({ f, disabled }: { f: CardFilter; disabled: boolean }): ReactElement {
  if (!f.hasSources) return <p className="text-xs text-muted">Nothing connected to filter yet.</p>;
  const { c, setC, mode } = f;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">{f.provider === 'github' ? 'File filtering' : 'Filtering'}</span>
        <PresetDropdown opts={f.opts} value={mode} disabled={disabled} onChange={f.onMode} />
        <span className="text-xs text-muted">{f.selectedDesc}</span>
      </div>

      {mode !== 'everything' ? (
        <div className="rounded-lg border border-border bg-bg p-3">
          {mode === 'custom' && f.provider === 'github' ? (
            <div className="mb-3 inline-flex rounded-md bg-bg p-0.5 text-xs">
              <button
                type="button"
                onClick={() => f.setGithubMode('exclude')}
                className={`rounded px-2.5 py-1 ${c.githubMode === 'exclude' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
              >
                Exclude these paths
              </button>
              <button
                type="button"
                onClick={() => f.setGithubMode('include')}
                className={`rounded px-2.5 py-1 ${c.githubMode === 'include' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
              >
                Only index these paths
              </button>
            </div>
          ) : null}

          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
            {mode === 'custom' ? (f.trelloToggleLists ? 'Exclude lists · tap to toggle' : f.customHeader) : 'Excluded by this preset'}
          </div>

          {f.trelloToggleLists ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {(f.trelloLists as string[]).map((list) => {
                const on = c.patterns.includes(list);
                return (
                  <button
                    key={list}
                    type="button"
                    onClick={() => f.toggleList(list)}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      on ? 'border-accent bg-accent/10 text-fg' : 'border-border bg-card text-muted hover:text-fg'
                    }`}
                  >
                    {on ? '✕ ' : ''}
                    {list}
                  </button>
                );
              })}
              {(f.trelloLists as string[]).length === 0 ? <span className="text-xs text-muted">No lists found.</span> : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {f.chips.map((chip) => (
                  <span
                    key={chip}
                    className={`inline-flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-xs ${
                      mode === 'custom' ? 'bg-card text-fg' : 'bg-card text-muted'
                    } ${f.mono ? 'font-mono' : ''}`}
                  >
                    {chip}
                    {mode === 'custom' ? (
                      <button
                        type="button"
                        aria-label={`Remove ${chip}`}
                        onClick={() => setC({ ...c, patterns: c.patterns.filter((p) => p !== chip) })}
                        className="text-muted hover:text-fg"
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                {f.chips.length === 0 && mode !== 'custom' ? <span className="text-xs text-muted">Nothing excluded.</span> : null}
              </div>
              {mode === 'custom' ? (
                <input
                  value={c.draft}
                  onChange={(e) => setC({ ...c, draft: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && c.draft.trim()) {
                      e.preventDefault();
                      setC({ ...c, patterns: [...c.patterns, c.draft.trim()], draft: '' });
                    }
                  }}
                  placeholder={f.addPlaceholder}
                  className={`mt-2 w-full rounded-md border border-dashed border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent ${f.mono ? 'font-mono' : ''}`}
                />
              ) : null}
            </>
          )}
          {f.provider === 'trello' && mode === 'custom' && f.trelloLists === undefined ? (
            <p className="mt-1 text-xs text-muted">Loading lists…</p>
          ) : null}

          {mode === 'custom' && f.provider === 'jira' ? (
            <ChipRow
              label="Exclude issue types"
              values={c.jiraTypes}
              draft={c.jiraTypeDraft}
              onDraft={(v) => setC({ ...c, jiraTypeDraft: v })}
              onAdd={(v) => setC({ ...c, jiraTypes: [...c.jiraTypes, v], jiraTypeDraft: '' })}
              onRemove={(v) => setC({ ...c, jiraTypes: c.jiraTypes.filter((t) => t !== v) })}
              placeholder="Add type, e.g. Sub-task"
            />
          ) : null}

          {mode === 'custom' && f.provider === 'trello' ? (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={c.trelloIncludeArchived}
                onChange={(e) => setC({ ...c, trelloIncludeArchived: e.target.checked })}
                className="h-4 w-4 flex-none accent-[var(--accent)]"
              />
              <span className="text-fg">Index completed / archived cards</span>
            </label>
          ) : null}

          {mode === 'custom' && f.provider !== 'github' ? (
            <div className="mt-3">
              <div className="mb-1.5 text-sm font-semibold text-fg">Exclude {f.ageNoun} not updated in</div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={c.ageValue}
                  onChange={(e) => setC({ ...c, ageValue: e.target.value })}
                  placeholder="12"
                  className="w-14 rounded-md border border-border bg-card px-2 py-1.5 text-center text-sm font-semibold text-fg"
                />
                <select
                  value={c.ageUnit}
                  onChange={(e) => setC({ ...c, ageUnit: e.target.value as AgeUnit })}
                  className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-fg"
                >
                  <option value="days">days</option>
                  <option value="months">months</option>
                  <option value="years">years</option>
                </select>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChipRow({
  label,
  values,
  draft,
  onDraft,
  onAdd,
  onRemove,
  placeholder,
}: {
  label: string;
  values: string[];
  draft: string;
  onDraft: (v: string) => void;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  placeholder: string;
}): ReactElement {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-sm font-semibold text-fg">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-0.5 text-xs text-fg">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onRemove(v)} className="text-muted hover:text-fg">
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              onAdd(draft.trim());
            }
          }}
          placeholder={placeholder}
          className="rounded border border-dashed border-border bg-transparent px-2 py-0.5 text-xs text-fg outline-none"
          style={{ minWidth: 150 }}
        />
      </div>
    </div>
  );
}

/** Map a stored preset key back to this connector's menu value. */
function mapPresetToOption(provider: Provider, preset: string | null): string {
  if (preset === 'index_everything') return 'everything';
  if (preset === 'code_only') return provider === 'github' ? 'code' : 'active';
  // recommended (or null) → the connector's default "active"/"recommended" option.
  return OPTIONS[provider][0]!.value;
}

/** The connector's menu LABEL for a stored preset key (null = inherit → the
 *  default option). Used by the card's header pill so Trello shows "Everything",
 *  not the generic "Index everything". */
export function connectorPresetLabel(provider: Provider, preset: string | null): string {
  if (preset === null) return OPTIONS[provider][0]!.label;
  const value = mapPresetToOption(provider, preset);
  return OPTIONS[provider].find((o) => o.value === value)?.label ?? OPTIONS[provider][0]!.label;
}
