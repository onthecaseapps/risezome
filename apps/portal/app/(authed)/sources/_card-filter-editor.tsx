'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { setSourcesCorpusPolicyAction } from './corpus-policy-action';
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

export interface CustomState {
  patterns: string[]; // github globs / jira statuses / trello lists
  draft: string;
  jiraTypes: string[];
  jiraTypeDraft: string;
  trelloIncludeArchived: boolean;
  ageValue: string;
  ageUnit: AgeUnit;
}

const EMPTY_CUSTOM: CustomState = {
  patterns: [],
  draft: '',
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
    if (c.patterns.length > 0) policy['customExcludes'] = c.patterns;
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

  const selected = opts.find((o) => o.value === mode) ?? opts[0]!;
  const chips = mode === 'custom' ? c.patterns : PRESET_CHIPS[provider][mode] ?? [];
  const mono = CHIP_LABEL_FONT_MONO[provider];
  const customNoun = provider === 'github' ? 'pattern' : provider === 'jira' ? 'status' : provider === 'trello' ? 'list' : 'item';
  const ageNoun = provider === 'jira' ? 'issues' : provider === 'trello' ? 'cards' : 'pages';

  const customHasContent =
    c.patterns.length > 0 || c.jiraTypes.length > 0 || c.ageValue.trim() !== '' || c.trelloIncludeArchived;
  const dirty = mode !== savedMode || (mode === 'custom' && customHasContent);

  function onMode(next: string): void {
    // Staged only — no reindex until Save.
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
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
            {mode === 'custom' ? `Exclude ${customNoun}s · editable` : 'Excluded by this preset'}
          </div>
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
                placeholder={
                  provider === 'github' ? 'Add pattern, e.g. vendor/**' : provider === 'jira' ? 'Add status, e.g. In Review' : 'Add list, e.g. Icebox'
                }
                className={`rounded border border-dashed border-border bg-transparent px-2 py-0.5 text-xs text-fg outline-none ${mono ? 'font-mono' : ''}`}
                style={{ minWidth: 170 }}
              />
            ) : null}
            {chips.length === 0 && mode !== 'custom' ? <span className="text-xs text-muted">Nothing excluded.</span> : null}
          </div>

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
