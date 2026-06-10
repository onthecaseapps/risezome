'use client';

import { useEffect, useState, useTransition, type ReactElement } from 'react';
import { setSourcesCorpusPolicyAction } from './corpus-policy-action';
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

export function CardFilterEditor({
  provider,
  sourceIds,
  currentPreset,
}: {
  provider: Provider;
  sourceIds: string[];
  currentPreset: string | null;
}): ReactElement {
  const opts = OPTIONS[provider];
  // Map the stored preset back to a menu value for the initial selection.
  const initial = mapPresetToOption(provider, currentPreset);
  const [mode, setMode] = useState<string>(initial);
  // The persisted selection. Editing stages changes; nothing reindexes until
  // Save. Discard reverts to this.
  const [savedMode, setSavedMode] = useState<string>(initial);
  const [c, setC] = useState<CustomState>(EMPTY_CUSTOM);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
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
    setNote(null);
  }

  function save(): void {
    const policy = mode === 'custom' ? buildCustomPolicy(provider, c) : buildPolicyForOption(provider, mode);
    setNote(null);
    start(async () => {
      const res = await setSourcesCorpusPolicyAction(sourceIds, policy as never);
      if (res.ok) {
        setSavedMode(mode);
        setNote(res.reindexed > 0 ? `Saved — reindexing ${String(res.reindexed)} source${res.reindexed === 1 ? '' : 's'}…` : 'Saved.');
      } else {
        setNote(`Couldn't save: ${res.error}`);
      }
    });
  }

  function discard(): void {
    setMode(savedMode);
    setC(EMPTY_CUSTOM);
    setNote(null);
  }

  if (sourceIds.length === 0) return <p className="text-xs text-muted">Nothing connected to filter yet.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">{provider === 'github' ? 'File filtering' : 'Filtering'}</span>
        <select
          value={mode}
          disabled={pending}
          onChange={(e) => onMode(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm text-fg disabled:opacity-50"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">{selected.desc}</span>
        {note !== null ? <span className="text-xs text-accent">{note}</span> : null}
      </div>

      {mode !== 'everything' && mode !== 'recommended-empty' ? (
        <div className="rounded-lg border border-border bg-bg p-3">
          {mode === 'custom' && provider === 'github' ? (
            <div className="mb-3 inline-flex rounded-md border border-border bg-card p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setGithubMode('exclude')}
                className={`rounded px-2 py-1 ${c.githubMode === 'exclude' ? 'bg-accent text-white' : 'text-muted'}`}
              >
                Exclude these paths
              </button>
              <button
                type="button"
                onClick={() => setGithubMode('include')}
                className={`rounded px-2 py-1 ${c.githubMode === 'include' ? 'bg-accent text-white' : 'text-muted'}`}
              >
                Only index these paths
              </button>
            </div>
          ) : null}

          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
            {mode === 'custom'
              ? trelloToggleLists
                ? 'Exclude lists · tap to toggle'
                : customHeader
              : 'Excluded by this preset'}
          </div>

          {trelloToggleLists ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {(trelloLists as string[]).map((list) => {
                const on = c.patterns.includes(list);
                return (
                  <button
                    key={list}
                    type="button"
                    onClick={() => toggleList(list)}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      on ? 'border-accent bg-accent/10 text-fg' : 'border-border bg-card text-muted hover:text-fg'
                    }`}
                  >
                    {on ? '✕ ' : ''}
                    {list}
                  </button>
                );
              })}
              {(trelloLists as string[]).length === 0 ? <span className="text-xs text-muted">No lists found.</span> : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((chip) => (
                  <span
                    key={chip}
                    className={`inline-flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-xs ${
                      mode === 'custom' ? 'bg-card text-fg' : 'bg-card text-muted'
                    } ${mono ? 'font-mono' : ''}`}
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
                {chips.length === 0 && mode !== 'custom' ? <span className="text-xs text-muted">Nothing excluded.</span> : null}
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
                  placeholder={addPlaceholder}
                  className={`mt-2 w-full rounded-md border border-dashed border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent ${mono ? 'font-mono' : ''}`}
                />
              ) : null}
            </>
          )}
          {provider === 'trello' && mode === 'custom' && trelloLists === undefined ? (
            <p className="mt-1 text-xs text-muted">Loading lists…</p>
          ) : null}

          {mode === 'custom' && provider === 'jira' ? (
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

          {mode === 'custom' && provider === 'trello' ? (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={c.trelloIncludeArchived}
                onChange={(e) => setC({ ...c, trelloIncludeArchived: e.target.checked })}
              />
              <span className="text-fg">Index completed / archived cards</span>
            </label>
          ) : null}

          {mode === 'custom' && provider !== 'github' ? (
            <div className="mt-3">
              <div className="mb-1.5 text-sm font-semibold text-fg">Exclude {ageNoun} not updated in</div>
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

      {dirty ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={save}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Save &amp; reindex
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={discard}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
          >
            Discard changes
          </button>
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
