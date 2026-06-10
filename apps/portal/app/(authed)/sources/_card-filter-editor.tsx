'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { setSourcesCorpusPolicyAction } from './corpus-policy-action';
import type { Provider } from './_source-item-list';

/**
 * Per-connection corpus-filtering editor (F4), matching the Sources mockup:
 * a preset dropdown + an "EXCLUDED BY THIS PRESET" chip box, plus a Custom
 * mode that reveals connector-appropriate controls (GitHub globs; Jira status/
 * type/age; Trello completed-cards toggle + lists + age; Confluence age).
 * Applies the chosen policy to every source in the connection and reindexes.
 */

const AGE_DAYS = { months: 30, years: 365 } as const;
const JIRA_DEFAULT_STATUSES = ['Done', 'Closed', 'Resolved', 'Cancelled', "Won't Do"];

const PRESET_CHIPS: Record<Provider, Record<string, string[]>> = {
  github: {
    recommended: ['**/*.test.*', '**/*.spec.*', '**/fixtures/**', '**/__mocks__/**', 'dist/**', 'build/**', '*.lock', '**/*.min.*'],
    code_only: ['…recommended', '**/*.md', '**/*.mdx', '**/*.rst'],
    index_everything: [],
  },
  jira: {
    recommended: JIRA_DEFAULT_STATUSES.map((s) => `status: ${s}`),
    code_only: JIRA_DEFAULT_STATUSES.map((s) => `status: ${s}`),
    index_everything: [],
  },
  trello: { recommended: ['archived cards'], code_only: ['archived cards'], index_everything: [] },
  confluence: { recommended: ['drafts & archived (not fetched)'], code_only: ['drafts & archived (not fetched)'], index_everything: [] },
};

const PRESET_LABEL: Record<string, string> = {
  recommended: 'Recommended',
  index_everything: 'Index everything',
  code_only: 'Code only',
  custom: 'Custom',
};

export interface CustomState {
  githubExcludes: string; // newline-separated globs
  jiraStatuses: string; // comma-separated
  jiraTypes: string;
  trelloIncludeArchived: boolean;
  trelloLists: string;
  agevalue: string; // number
  ageUnit: 'months' | 'years';
}

const EMPTY_CUSTOM: CustomState = {
  githubExcludes: '',
  jiraStatuses: JIRA_DEFAULT_STATUSES.join(', '),
  jiraTypes: '',
  trelloIncludeArchived: false,
  trelloLists: '',
  agevalue: '',
  ageUnit: 'years',
};

function splitList(v: string): string[] {
  return v.split(/[,\n]/).map((x) => x.trim()).filter((x) => x.length > 0);
}

export function buildCustomPolicy(provider: Provider, c: CustomState): Record<string, unknown> {
  const policy: Record<string, unknown> = { preset: 'recommended' };
  const rules: Array<Record<string, unknown>> = [];
  const ageDays = c.agevalue.trim() !== '' ? Number(c.agevalue) * AGE_DAYS[c.ageUnit] : null;

  if (provider === 'github') {
    const ex = splitList(c.githubExcludes);
    if (ex.length > 0) policy['customExcludes'] = ex;
  }
  if (provider === 'jira') {
    const st = splitList(c.jiraStatuses);
    if (st.length > 0) rules.push({ source: 'jira', field: 'status', op: 'in', value: st });
    const ty = splitList(c.jiraTypes);
    if (ty.length > 0) rules.push({ source: 'jira', field: 'issueType', op: 'in', value: ty });
    if (ageDays !== null) rules.push({ source: 'jira', field: 'updatedBefore', op: 'olderThanDays', value: ageDays });
  }
  if (provider === 'trello') {
    policy['connectorOptions'] = { trello: { includeArchived: c.trelloIncludeArchived } };
    const lists = splitList(c.trelloLists);
    if (lists.length > 0) rules.push({ source: 'trello', field: 'list', op: 'in', value: lists });
    if (ageDays !== null) rules.push({ source: 'trello', field: 'updatedBefore', op: 'olderThanDays', value: ageDays });
  }
  if (provider === 'confluence') {
    if (ageDays !== null) rules.push({ source: 'confluence', field: 'updatedBefore', op: 'olderThanDays', value: ageDays });
  }
  if (rules.length > 0) policy['connectorRules'] = rules;
  return policy;
}

export function CardFilterEditor({
  provider,
  sourceIds,
  currentPreset,
  orgDefaultPreset,
}: {
  provider: Provider;
  sourceIds: string[];
  currentPreset: string | null; // override preset, or null = inherit org default
  orgDefaultPreset: string;
}): ReactElement {
  const initialMode = currentPreset ?? 'inherit';
  const [mode, setMode] = useState<string>(initialMode);
  const [custom, setCustom] = useState<CustomState>(EMPTY_CUSTOM);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const effectivePreset = mode === 'inherit' ? orgDefaultPreset : mode === 'custom' ? 'recommended' : mode;
  const chips = PRESET_CHIPS[provider][effectivePreset] ?? [];

  function apply(nextPolicy: Record<string, unknown> | null): void {
    setNote(null);
    start(async () => {
      const res = await setSourcesCorpusPolicyAction(sourceIds, nextPolicy as never);
      setNote(res.ok ? `Reindexing ${String(res.reindexed)} source${res.reindexed === 1 ? '' : 's'}…` : `Couldn't save: ${res.error}`);
    });
  }

  function onModeChange(next: string): void {
    setMode(next);
    setNote(null);
    if (next === 'inherit') apply(null);
    else if (next !== 'custom') apply({ preset: next });
    // custom waits for the Save button
  }

  if (sourceIds.length === 0) {
    return <p className="text-xs text-muted">Connect a {provider === 'github' ? 'repo' : 'source'} to configure filtering.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">Filtering</span>
        <select
          value={mode}
          disabled={pending}
          onChange={(e) => onModeChange(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm text-fg disabled:opacity-50"
        >
          <option value="inherit">Inherit ({PRESET_LABEL[orgDefaultPreset] ?? orgDefaultPreset})</option>
          <option value="recommended">Recommended</option>
          <option value="index_everything">Index everything</option>
          {provider === 'github' ? <option value="code_only">Code only</option> : null}
          <option value="custom">Custom…</option>
        </select>
        {note !== null ? <span className="text-xs text-muted">{note}</span> : null}
      </div>

      {mode !== 'custom' && chips.length > 0 ? (
        <div className="rounded-lg border border-border bg-bg p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Excluded by this preset</div>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <span key={chip} className="rounded border border-border bg-card px-2 py-0.5 font-mono text-xs text-muted">
                {chip}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {mode === 'custom' ? (
        <div className="space-y-3 rounded-lg border border-border bg-bg p-3 text-sm">
          {provider === 'github' ? (
            <Field label="Exclude paths (gitignore globs, one per line)">
              <textarea
                rows={4}
                value={custom.githubExcludes}
                onChange={(e) => setCustom({ ...custom, githubExcludes: e.target.value })}
                placeholder={'**/test/**\n*.lock\ndist/**'}
                className="w-full rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-fg"
              />
            </Field>
          ) : null}

          {provider === 'jira' ? (
            <>
              <Field label="Exclude issues with status (comma-separated)">
                <input value={custom.jiraStatuses} onChange={(e) => setCustom({ ...custom, jiraStatuses: e.target.value })} className={inputCls} placeholder="Done, Closed, Resolved" />
              </Field>
              <Field label="Exclude issue types (comma-separated, optional)">
                <input value={custom.jiraTypes} onChange={(e) => setCustom({ ...custom, jiraTypes: e.target.value })} className={inputCls} placeholder="Sub-task, Epic" />
              </Field>
              <AgeField custom={custom} setCustom={setCustom} noun="issues" />
            </>
          ) : null}

          {provider === 'trello' ? (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={custom.trelloIncludeArchived} onChange={(e) => setCustom({ ...custom, trelloIncludeArchived: e.target.checked })} />
                <span className="text-fg">Index completed / archived cards</span>
              </label>
              <Field label="Exclude lists (comma-separated, optional)">
                <input value={custom.trelloLists} onChange={(e) => setCustom({ ...custom, trelloLists: e.target.value })} className={inputCls} placeholder="Icebox, Done" />
              </Field>
              <AgeField custom={custom} setCustom={setCustom} noun="cards" />
            </>
          ) : null}

          {provider === 'confluence' ? <AgeField custom={custom} setCustom={setCustom} noun="pages" /> : null}

          <button
            type="button"
            disabled={pending}
            onClick={() => apply(buildCustomPolicy(provider, custom))}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Save & reindex
          </button>
        </div>
      ) : null}
    </div>
  );
}

const inputCls = 'w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-fg';

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted">{label}</label>
      {children}
    </div>
  );
}

function AgeField({
  custom,
  setCustom,
  noun,
}: {
  custom: CustomState;
  setCustom: (c: CustomState) => void;
  noun: string;
}): ReactElement {
  return (
    <Field label={`Exclude ${noun} not updated in (optional)`}>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          value={custom.agevalue}
          onChange={(e) => setCustom({ ...custom, agevalue: e.target.value })}
          className="w-20 rounded-md border border-border bg-card px-2 py-1 text-sm text-fg"
          placeholder="2"
        />
        <select
          value={custom.ageUnit}
          onChange={(e) => setCustom({ ...custom, ageUnit: e.target.value as 'months' | 'years' })}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm text-fg"
        >
          <option value="months">months</option>
          <option value="years">years</option>
        </select>
      </div>
    </Field>
  );
}
