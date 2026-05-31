/**
 * Postgres filter helpers shared by the corpus skills (github_count,
 * github_list, github_by_author, github_recently_updated).
 *
 * Two compositions, mirroring the daemon's `apps/daemon/src/skills/github/filter.ts`:
 *   - applyDocFilter applies type + author + source to a PostgREST query
 *     builder on the `docs` table.
 *   - ftsPhraseQuery builds the `websearch_to_tsquery` input for state +
 *     labels filters that live inside chunk text.
 *
 * When a chunk-level filter is present, the caller queries
 * `doc_chunks` first to get the matching doc_ids, then narrows the
 * docs query via `.in('id', docIds)`. This is a two-round-trip pattern
 * (vs the daemon's single SQLite JOIN) but keeps the SQL simple
 * enough that it's expressible in PostgREST query-builder syntax
 * rather than a stored procedure.
 */

import type { SkillDbClient } from '@risezome/engine/skills';

export interface GithubFilter {
  /** 'issue' | 'pull-request' */
  readonly type?: string;
  /** 'open' | 'closed' */
  readonly state?: string;
  /** Issue/PR labels. Multi-label means AND. */
  readonly labels?: readonly string[];
  /** GitHub login (matches docs.authors jsonb array). */
  readonly author?: string;
}

/**
 * Build the websearch_to_tsquery input string for state + labels.
 * Returns null when neither is present (caller skips the chunk-side
 * lookup entirely).
 *
 * Format: `"Status open" "Labels bug" "Labels p0"` — multiple phrase
 * queries combined with implicit AND. Postgres' websearch_to_tsquery
 * parses double-quoted strings as phrase queries against the
 * tsvector's positional tokens. Matches the daemon's behavior of
 * AND-ing each state/label phrase.
 */
export function ftsPhraseQuery(filter: GithubFilter): string | null {
  const phrases: string[] = [];
  if (typeof filter.state === 'string' && filter.state.length > 0) {
    phrases.push(`"Status ${filter.state}"`);
  }
  if (filter.labels !== undefined) {
    for (const label of filter.labels) {
      if (label.length === 0) continue;
      phrases.push(`"Labels ${label}"`);
    }
  }
  if (phrases.length === 0) return null;
  return phrases.join(' ');
}

/**
 * Look up the doc_ids that match a chunk-level FTS phrase query,
 * scoped to org. Returns DISTINCT doc_ids deduplicated in JS (PostgREST
 * doesn't support DISTINCT in select; doing it client-side is cheap
 * for the small result sets corpus skills work with).
 */
export async function lookupChunkMatchDocIds(
  db: SkillDbClient,
  orgId: string,
  phraseQuery: string,
): Promise<string[]> {
  // `as any` here because the SkillDbClient interface is the
  // duck-typed minimal shape; the runtime is the real SupabaseClient
  // with chainable query builders the structural type can't fully
  // express.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = db.from('doc_chunks') as any;
  const { data, error } = (await builder
    .select('doc_id')
    .eq('org_id', orgId)
    .textSearch('text_fts', phraseQuery, { type: 'websearch', config: 'english' })) as {
    data: Array<{ doc_id: string }> | null;
    error: unknown;
  };
  if (error !== null && error !== undefined) {
    throw new Error(`doc_chunks FTS lookup failed: ${String((error as { message?: string }).message ?? error)}`);
  }
  const rows = data ?? [];
  return Array.from(new Set(rows.map((r) => r.doc_id)));
}

export interface DocRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly updated_at: string;
}
