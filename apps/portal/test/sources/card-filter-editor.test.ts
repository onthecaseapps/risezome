import { describe, expect, it } from 'vitest';
import { buildCustomPolicy, type CustomState } from '../../app/(authed)/sources/_card-filter-editor';

const base: CustomState = {
  patterns: [],
  draft: '',
  githubMode: 'exclude',
  jiraTypes: [],
  jiraTypeDraft: '',
  trelloIncludeArchived: false,
  ageValue: '',
  ageUnit: 'months',
};

describe('buildCustomPolicy', () => {
  it('github exclude mode: pattern chips become customExcludes', () => {
    const p = buildCustomPolicy('github', { ...base, patterns: ['**/test/**', '*.lock'] });
    expect(p).toMatchObject({ preset: 'recommended', customExcludes: ['**/test/**', '*.lock'] });
    expect(p['connectorRules']).toBeUndefined();
    expect(p['customIncludeOnly']).toBeUndefined();
  });

  it('github include mode: pattern chips become customIncludeOnly (allowlist)', () => {
    const p = buildCustomPolicy('github', { ...base, githubMode: 'include', patterns: ['packages/api/**'] });
    expect(p).toMatchObject({ preset: 'recommended', customIncludeOnly: ['packages/api/**'] });
    expect(p['customExcludes']).toBeUndefined();
  });

  it('jira: status chips + type chips + age become connector rules', () => {
    const p = buildCustomPolicy('jira', { ...base, patterns: ['Done', 'Closed'], jiraTypes: ['Sub-task'], ageValue: '2', ageUnit: 'years' });
    expect(p['connectorRules']).toEqual([
      { source: 'jira', field: 'status', op: 'in', value: ['Done', 'Closed'] },
      { source: 'jira', field: 'issueType', op: 'in', value: ['Sub-task'] },
      { source: 'jira', field: 'updatedBefore', op: 'olderThanDays', value: 730 },
    ]);
  });

  it('trello: includeArchived toggle + list chips + age (days)', () => {
    const p = buildCustomPolicy('trello', { ...base, trelloIncludeArchived: true, patterns: ['Icebox'], ageValue: '90', ageUnit: 'days' });
    expect(p['connectorOptions']).toEqual({ trello: { includeArchived: true } });
    expect(p['connectorRules']).toEqual([
      { source: 'trello', field: 'list', op: 'in', value: ['Icebox'] },
      { source: 'trello', field: 'updatedBefore', op: 'olderThanDays', value: 90 },
    ]);
  });

  it('confluence: only an age rule (months)', () => {
    const p = buildCustomPolicy('confluence', { ...base, ageValue: '18', ageUnit: 'months' });
    expect(p['connectorRules']).toEqual([
      { source: 'confluence', field: 'updatedBefore', op: 'olderThanDays', value: 540 },
    ]);
  });

  it('empty inputs produce a bare recommended policy', () => {
    expect(buildCustomPolicy('confluence', base)).toEqual({ preset: 'recommended' });
  });
});
