// Filter helpers shared across the github_count / github_list / github_recently_updated
// / github_by_author skills. Two builders:
//
// - buildDocFilter constructs a WHERE clause + params for the `docs` table
//   (type, author, updated_at — fields physically present as columns).
// - buildChunkMatch builds the FTS5 MATCH expression for filters that live
//   inside the chunk text (state and labels — present only as natural-
//   language sentences like `Status: open. Labels: bug.` after the A-E
//   chunker fix).
//
// The configured FTS5 tokenizer is `unicode61 remove_diacritics 2`, which
// strips `:` from `Status: open`, so the phrase form is "Status open" (two
// consecutive tokens after tokenization). The smoke script
// `scripts/fts5-smoke.ts` verifies this against the live corpus.

export interface GithubFilter {
  /** 'issue' | 'pull-request' */
  readonly type?: string;
  /** 'open' | 'closed' */
  readonly state?: string;
  /** Issue/PR labels. Multi-label means AND. */
  readonly labels?: readonly string[];
  /** GitHub login (matches the authors JSON array via LIKE). */
  readonly author?: string;
}

export interface DocFilterSQL {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

export function buildDocFilter(filter: GithubFilter): DocFilterSQL {
  const clauses: string[] = ['docs.source = ?'];
  const params: (string | number)[] = ['github'];
  if (typeof filter.type === 'string' && filter.type.length > 0) {
    clauses.push('docs.type = ?');
    params.push(filter.type);
  }
  if (typeof filter.author === 'string' && filter.author.length > 0) {
    // docs.authors is stored as a JSON array string like '["Nath5","alice"]'.
    // LIKE with the surrounding quotes prevents 'al' from matching 'alice'.
    clauses.push('docs.authors LIKE ?');
    params.push(`%"${filter.author}"%`);
  }
  return {
    sql: clauses.join(' AND '),
    params,
  };
}

/**
 * Build the FTS5 MATCH expression for state + labels filters. Returns null
 * when neither is present (caller skips the FTS5 join). The result is a
 * phrase-AND expression: `"Status open" AND "Labels bug" AND "Labels phase-3"`.
 */
export function buildChunkMatch(filter: GithubFilter): string | null {
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
  return phrases.join(' AND ');
}

export interface DocRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly updated_at: number;
}
