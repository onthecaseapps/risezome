import { describe, expect, it } from 'vitest';
import { buildGithubItems, type GithubSourceRow } from '../../app/(authed)/sources/_github-items';

function repo(over: Partial<GithubSourceRow> & { id: string; repo_full_name: string }): GithubSourceRow {
  return {
    installation_id: 1,
    status: 'indexed',
    indexed_files: 10,
    total_files: 10,
    ...over,
  };
}

describe('buildGithubItems', () => {
  it('marks a repo selected when its source is in the team_sources set', () => {
    const repos = [repo({ id: 's1', repo_full_name: 'acme/api' })];
    const { items, selected } = buildGithubItems(repos, new Set(['s1']), 1);
    expect(selected).toEqual(['acme/api']);
    expect(items[0]).toMatchObject({ sourceId: 's1', externalId: 'acme/api', status: 'indexed', count: 10 });
  });

  it('shows an active-but-unselected repo with its source id + status, not selected', () => {
    const repos = [repo({ id: 's1', repo_full_name: 'acme/api' })];
    const { items, selected } = buildGithubItems(repos, new Set(), 1);
    expect(selected).toEqual([]);
    expect(items[0]).toMatchObject({ sourceId: 's1', status: 'indexed' });
  });

  it('offers a REMOVED (de-indexed) repo as an available, unchecked item with no sourceId/status/counts', () => {
    // The regression: a removed source used to be filtered out entirely, so the
    // repo vanished and could never be re-selected. It must now appear, ready to
    // be re-selected (which revives it via addSourceToTeam).
    const repos = [repo({ id: 's1', repo_full_name: 'acme/api', status: 'removed', indexed_files: 7, total_files: 9 })];
    const { items, selected } = buildGithubItems(repos, new Set(), 1);
    expect(selected).toEqual([]); // removed sources aren't in team_sources → unchecked
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 's1',
      externalId: 'acme/api',
      label: 'acme/api',
      count: null,
      total: null,
      status: null,
      installationId: 1,
    });
    expect(items[0]!.sourceId).toBeUndefined(); // not reindexable until revived
  });

  it('keeps active repos selectable alongside removed ones, sorted by label', () => {
    const repos = [
      repo({ id: 's2', repo_full_name: 'acme/zeta' }),
      repo({ id: 's1', repo_full_name: 'acme/alpha', status: 'removed' }),
    ];
    const { items, selected } = buildGithubItems(repos, new Set(['s2']), 1);
    expect(items.map((i) => i.externalId)).toEqual(['acme/alpha', 'acme/zeta']); // sorted
    expect(selected).toEqual(['acme/zeta']);
  });
});
