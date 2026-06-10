import { describe, expect, it } from 'vitest';
import { buildCustomPolicy, type CustomState } from '../../app/(authed)/sources/_card-filter-editor';

const base: CustomState = {
  githubExcludes: '',
  jiraStatuses: '',
  jiraTypes: '',
  trelloIncludeArchived: false,
  trelloLists: '',
  agevalue: '',
  ageUnit: 'years',
};

describe('buildCustomPolicy', () => {
  it('github: newline globs become customExcludes', () => {
    const p = buildCustomPolicy('github', { ...base, githubExcludes: '**/test/**\n*.lock' });
    expect(p).toMatchObject({ preset: 'recommended', customExcludes: ['**/test/**', '*.lock'] });
    expect(p['connectorRules']).toBeUndefined();
  });

  it('jira: statuses + types + age become connector rules', () => {
    const p = buildCustomPolicy('jira', { ...base, jiraStatuses: 'Done, Closed', jiraTypes: 'Sub-task', agevalue: '2', ageUnit: 'years' });
    expect(p['connectorRules']).toEqual([
      { source: 'jira', field: 'status', op: 'in', value: ['Done', 'Closed'] },
      { source: 'jira', field: 'issueType', op: 'in', value: ['Sub-task'] },
      { source: 'jira', field: 'updatedBefore', op: 'olderThanDays', value: 730 },
    ]);
  });

  it('trello: includeArchived option + list rule + age (months)', () => {
    const p = buildCustomPolicy('trello', { ...base, trelloIncludeArchived: true, trelloLists: 'Icebox, Done', agevalue: '6', ageUnit: 'months' });
    expect(p['connectorOptions']).toEqual({ trello: { includeArchived: true } });
    expect(p['connectorRules']).toEqual([
      { source: 'trello', field: 'list', op: 'in', value: ['Icebox', 'Done'] },
      { source: 'trello', field: 'updatedBefore', op: 'olderThanDays', value: 180 },
    ]);
  });

  it('confluence: only an age rule', () => {
    const p = buildCustomPolicy('confluence', { ...base, agevalue: '3', ageUnit: 'years' });
    expect(p['connectorRules']).toEqual([
      { source: 'confluence', field: 'updatedBefore', op: 'olderThanDays', value: 1095 },
    ]);
  });

  it('empty inputs produce a bare recommended policy', () => {
    expect(buildCustomPolicy('confluence', base)).toEqual({ preset: 'recommended' });
  });
});
