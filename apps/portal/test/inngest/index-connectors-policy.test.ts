import { describe, expect, it } from 'vitest';
import { filterEntitiesByPolicy } from '../../src/inngest/lib/connector-index';
import { resolveEffectivePolicy, type EntityAttrs } from '../../src/inngest/lib/corpus-policy';

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
