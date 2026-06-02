/**
 * Self-healing helpers for the live GitHub skills (plan U2).
 *
 * Spoken meeting phrasing makes the classifier mis-extract free-text args —
 * "how many open *case* issues" → `labels:["case"]`, a label that doesn't
 * exist, which the Search API silently answers with `0`. These helpers
 * validate a spoken `labels` arg against the repos' real label sets so a
 * non-existent value is neutralized (and surfaced honestly) instead of
 * producing a confidently-wrong count. Author validation reuses
 * `resolvePerson`; only labels need a new fetch.
 *
 * Validation fires only when the risky arg is present, so the safe-enum-only
 * common path pays nothing (plan R2).
 */
import type { GithubClient } from './client.js';
import type { GithubAccess } from './source-resolver.js';
import { authForToken } from './live-helpers.js';

/** Page size + bound for the repo-labels fetch. Most repos carry well under
 *  100 labels; the bound stops a pathological repo from fanning out forever. */
const LABEL_PAGE_SIZE = 100;
const MAX_LABEL_PAGES = 5;

interface GithubLabel {
  readonly name: string;
}

/**
 * Union of real label names across every connected repo, lowercased for
 * case-insensitive membership. One `GET /repos/{owner}/{name}/labels` per repo
 * (paginated, bounded), using that installation's token. A label is valid if
 * it exists in ANY connected repo (union semantics, plan KTD6) — so a label
 * real in repo B isn't neutralized because repo A lacks it.
 *
 * Throws if a fetch fails; the caller degrades that to an `'unresolved'`
 * recovery (drop to RAG) rather than answering on an unverified domain.
 */
export async function collectRepoLabelUnion(
  client: GithubClient,
  access: GithubAccess,
): Promise<Set<string>> {
  const union = new Set<string>();
  for (const inst of access.installations) {
    const auth = authForToken(inst.token);
    for (const repo of inst.repos) {
      for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
        const labels = await client.getJson<GithubLabel[]>(
          auth,
          `/repos/${repo.owner}/${repo.name}/labels`,
          { per_page: String(LABEL_PAGE_SIZE), page: String(page) },
        );
        if (!Array.isArray(labels)) break;
        for (const l of labels) {
          if (typeof l.name === 'string') union.add(l.name.toLowerCase());
        }
        if (labels.length < LABEL_PAGE_SIZE) break;
      }
    }
  }
  return union;
}

/**
 * Split provided labels into those real in the domain union and those that
 * aren't. Case-insensitive (mirrors GitHub label matching); empty values are
 * ignored (treated as neither valid nor bogus).
 */
export function partitionLabels(
  provided: readonly string[],
  union: ReadonlySet<string>,
): { readonly valid: string[]; readonly bogus: string[] } {
  const valid: string[] = [];
  const bogus: string[] = [];
  for (const label of provided) {
    if (label.length === 0) continue;
    if (union.has(label.toLowerCase())) valid.push(label);
    else bogus.push(label);
  }
  return { valid, bogus };
}

export interface NeutralizedArg {
  readonly arg: string;
  readonly value: string;
}

/**
 * Compose an honest caveat from the neutralized args, e.g.
 * "There's no GitHub label 'case' — ignoring that filter."
 */
export function buildGithubNote(neutralized: readonly NeutralizedArg[]): string {
  const labels = neutralized.filter((n) => n.arg === 'labels').map((n) => n.value);
  const authors = neutralized.filter((n) => n.arg === 'author').map((n) => n.value);
  const parts: string[] = [];
  if (labels.length > 0) parts.push(`no GitHub label ${quoteList(labels)}`);
  if (authors.length > 0) parts.push(`no GitHub user matching ${quoteList(authors)}`);
  const filterWord = parts.length > 1 ? 'those filters' : 'that filter';
  return `There's ${parts.join(' and ')} — ignoring ${filterWord}.`;
}

function quoteList(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length === 2) return `${quoted[0]!} and ${quoted[1]!}`;
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]!}`;
}
