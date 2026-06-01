import type { GithubFilter } from './filter.js';

/**
 * Summary-string builder for github_count, shared by the corpus-backed
 * count.ts and the live Search-API search_count.ts so both produce
 * byte-identical wording. Lifted verbatim from the daemon's
 * apps/daemon/src/skills/github/count.ts — the synthesizer's prompt is
 * tuned against this exact phrasing; do not reword without updating
 * the snapshot tests in lockstep.
 */
export function summarizeCount(count: number, filter: GithubFilter): string {
  if (count === 0) return `No matching ${docTypeLabel(filter)}.`;
  const noun = count === 1 ? docTypeNoun(filter) : docTypePlural(filter);
  const stateAdj = filter.state !== undefined ? ` ${filter.state}` : '';
  const labels =
    filter.labels !== undefined && filter.labels.length > 0
      ? ` labeled ${filter.labels.map((l) => `'${l}'`).join(' and ')}`
      : '';
  const author = filter.author !== undefined ? ` by ${filter.author}` : '';
  return `${String(count)}${stateAdj} ${noun}${labels}${author}.`;
}

function docTypeLabel(filter: GithubFilter): string {
  if (filter.type === 'issue') return 'issues';
  if (filter.type === 'pull-request') return 'pull requests';
  return 'docs';
}

function docTypeNoun(filter: GithubFilter): string {
  if (filter.type === 'issue') return 'issue';
  if (filter.type === 'pull-request') return 'pull request';
  return 'doc';
}

function docTypePlural(filter: GithubFilter): string {
  return docTypeLabel(filter);
}
