import { describe, expect, it } from 'vitest';
import { filterEntitiesByPolicy, keepWithVisibility } from '../../src/inngest/lib/connector-index';
import { resolveEffectivePolicy, type EntityAttrs, type TeamView } from '../../src/inngest/lib/corpus-policy';

interface Issue { key: string; status: string }
interface Card { id: string; list: string; updated: string }
interface Page { id: string; updated: string }

const issueAttrs = (i: Issue): EntityAttrs => ({ status: i.status });
const cardAttrs = (c: Card): EntityAttrs => ({ list: c.list, updatedAt: c.updated });
const pageAttrs = (p: Page): EntityAttrs => ({ updatedAt: p.updated });

describe('filterEntitiesByPolicy (U5)', () => {
  it('jira recommended drops Done/Closed, keeps active', () => {
    const policy = resolveEffectivePolicy(null, null);
    const issues: Issue[] = [
      { key: 'A-1', status: 'In Progress' },
      { key: 'A-2', status: 'Done' },
      { key: 'A-3', status: 'Closed' },
    ];
    const kept = filterEntitiesByPolicy(issues, 'jira', policy, issueAttrs);
    expect(kept.map((i) => i.key)).toEqual(['A-1']);
  });

  it('trello/confluence have no default rule (all kept under recommended)', () => {
    const policy = resolveEffectivePolicy(null, null);
    const cards: Card[] = [{ id: 'c1', list: 'Done', updated: '2020-01-01T00:00:00Z' }];
    const pages: Page[] = [{ id: 'p1', updated: '2019-01-01T00:00:00Z' }];
    expect(filterEntitiesByPolicy(cards, 'trello', policy, cardAttrs)).toHaveLength(1);
    expect(filterEntitiesByPolicy(pages, 'confluence', policy, pageAttrs)).toHaveLength(1);
  });

  it('applies a custom trello list rule and confluence age rule', () => {
    const policy = resolveEffectivePolicy(null, {
      preset: 'recommended',
      connectorRules: [
        { source: 'trello', field: 'list', op: 'in', value: ['Archive'] },
        { source: 'confluence', field: 'updatedBefore', op: 'olderThanDays', value: 365 },
      ],
    });
    const cards: Card[] = [
      { id: 'c1', list: 'Archive', updated: '2026-06-01T00:00:00Z' },
      { id: 'c2', list: 'Backlog', updated: '2026-06-01T00:00:00Z' },
    ];
    expect(filterEntitiesByPolicy(cards, 'trello', policy, cardAttrs).map((c) => c.id)).toEqual(['c2']);

    const pages: Page[] = [
      { id: 'old', updated: '2020-01-01T00:00:00Z' },
      { id: 'new', updated: '2026-06-01T00:00:00Z' },
    ];
    // Age compares to now; the very old page is dropped.
    const kept = filterEntitiesByPolicy(pages, 'confluence', policy, pageAttrs);
    expect(kept.some((p) => p.id === 'old')).toBe(false);
  });

  it('no-ops when policy is absent or attrs extractor is missing', () => {
    const policy = resolveEffectivePolicy(null, null);
    const issues: Issue[] = [{ key: 'A-2', status: 'Done' }];
    expect(filterEntitiesByPolicy(issues, 'jira', undefined, issueAttrs)).toHaveLength(1);
    expect(filterEntitiesByPolicy(issues, 'jira', policy, undefined)).toHaveLength(1);
  });

  it('index_everything keeps all entities', () => {
    const policy = resolveEffectivePolicy(null, { preset: 'index_everything' });
    const issues: Issue[] = [{ key: 'A-2', status: 'Done' }];
    expect(filterEntitiesByPolicy(issues, 'jira', policy, issueAttrs)).toHaveLength(1);
  });
});

describe('keepWithVisibility (query-time union, U3)', () => {
  const issueAttrs2 = (i: Issue): EntityAttrs => ({ status: i.status });
  // Team A = recommended (drops Done), Team B = everything.
  const views: TeamView[] = [
    { teamId: 'A', policy: resolveEffectivePolicy(null, { preset: 'recommended' }) },
    { teamId: 'B', policy: resolveEffectivePolicy(null, { preset: 'index_everything' }) },
  ];

  it('keeps an entity admitted by ANY team (union) and records the admitting teams', () => {
    const issues: Issue[] = [
      { key: 'A-1', status: 'In Progress' }, // both teams
      { key: 'A-2', status: 'Done' }, // only B (recommended drops Done)
    ];
    const { entities, keptVis } = keepWithVisibility(issues, 'jira', views, undefined, issueAttrs2);
    expect(entities.map((e) => e.key)).toEqual(['A-1', 'A-2']); // union keeps both
    expect(keptVis[0]!.sort()).toEqual(['A', 'B']);
    expect(keptVis[1]).toEqual(['B']); // Done visible only to the everything team
  });

  it('drops an entity NO team admits (empty union)', () => {
    const onlyRecommended: TeamView[] = [
      { teamId: 'A', policy: resolveEffectivePolicy(null, { preset: 'recommended' }) },
    ];
    const issues: Issue[] = [{ key: 'A-2', status: 'Done' }];
    const { entities } = keepWithVisibility(issues, 'jira', onlyRecommended, undefined, issueAttrs2);
    expect(entities).toEqual([]); // Done dropped — no team wants it
  });

  it('falls back to single-policy keep (empty visibility) when no team views', () => {
    const issues: Issue[] = [
      { key: 'A-1', status: 'In Progress' },
      { key: 'A-2', status: 'Done' },
    ];
    const policy = resolveEffectivePolicy(null, null); // recommended
    const { entities, keptVis } = keepWithVisibility(issues, 'jira', [], policy, issueAttrs2);
    expect(entities.map((e) => e.key)).toEqual(['A-1']); // Done dropped by single policy
    expect(keptVis).toEqual([[]]); // no per-team visibility in the fallback
  });
});
