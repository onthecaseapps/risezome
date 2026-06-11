import type { SourceItem } from './_source-item-list';

/** The subset of a GitHub `sources` row the Sources page reads. */
export interface GithubSourceRow {
  excluded_count?: number;
  corpus_policy?: { preset?: string } | null;
  id: string;
  repo_full_name: string;
  installation_id: number | null;
  status: string;
  indexed_files: number;
  total_files: number | null;
}

/**
 * Build the checklist items + selected set for one GitHub installation.
 *
 * A repo is "selected" when its (non-removed) source is in the team's
 * team_sources. A `removed` (de-indexed) source is still offered as an
 * available, UNCHECKED item so it can be re-selected — but it carries no
 * sourceId/status/counts, because a de-indexed repo is not reindexable until
 * re-selecting revives it (addSourceToTeam resets status + clears removed_at).
 *
 * This is the GitHub analogue of how Trello/Atlassian surface removed sources:
 * those reappear via their live board/project listing, but GitHub has no live
 * repo listing on this page, so the removed source rows themselves are the only
 * way a de-indexed repo stays re-selectable.
 */
export function buildGithubItems(
  repos: GithubSourceRow[],
  teamSourceIds: Set<string>,
  installationId: number,
  viewPresetBySource: Map<string, string | null>,
): { items: SourceItem[]; selected: string[] } {
  const items: SourceItem[] = repos.map((s) => {
    const removed = s.status === 'removed';
    return {
      key: s.id,
      ...(removed ? {} : { sourceId: s.id }),
      externalId: s.repo_full_name,
      label: s.repo_full_name,
      count: removed ? null : s.indexed_files,
      total: removed ? null : s.total_files,
      status: removed ? null : s.status,
      excluded: removed ? 0 : (s.excluded_count ?? 0),
      // The team's view preset (query-time filtering), not the shared source policy.
      presetKey: viewPresetBySource.get(s.id) ?? null,
      installationId,
    };
  });
  items.sort((x, y) => x.label.localeCompare(y.label));
  const selected = repos.filter((s) => teamSourceIds.has(s.id)).map((s) => s.repo_full_name);
  return { items, selected };
}
