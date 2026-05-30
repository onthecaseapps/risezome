import type { AuthResult, DeltaPage, ScopeDescriptor } from '../contract.js';
import type { CanonicalChunk, CanonicalDoc } from '../../corpus/types.js';
import { type GithubClient } from './client.js';
import { chunkIsMeaningful } from './chunk-shared.js';
import type { GithubIssue } from './types.js';

export const GITHUB_DEFAULT_PAGE_SIZE = 100;

interface PullDeltaOptions {
  readonly pageSize?: number;
  readonly since?: string;
}

export async function pullRepoIssuesAndPRs(
  client: GithubClient,
  auth: AuthResult,
  scope: ScopeDescriptor,
  cursor: string | null,
  options: PullDeltaOptions = {},
): Promise<DeltaPage> {
  const pageSize = options.pageSize ?? GITHUB_DEFAULT_PAGE_SIZE;
  const sinceParam = parseCursorSince(cursor) ?? options.since;
  const ownerRepo = scope.id;

  const query: Record<string, string> = {
    state: 'all',
    sort: 'updated',
    direction: 'asc',
    per_page: String(pageSize),
  };
  if (sinceParam !== undefined) query.since = sinceParam;

  const issues = await client.getJson<GithubIssue[]>(auth, `/repos/${ownerRepo}/issues`, query);

  const docs: CanonicalDoc[] = [];
  const chunks: CanonicalChunk[] = [];

  for (const issue of issues) {
    const docId = canonicalDocId(ownerRepo, issue);
    const isPr = issue.pull_request !== undefined;
    const headerText = renderHeader(ownerRepo, issue);
    const body = issue.body ?? '';

    docs.push({
      id: docId,
      source: 'github',
      type: isPr ? 'pull-request' : 'issue',
      title: issue.title,
      bodySummary: truncate(body, 240),
      entities: [`${ownerRepo}#${String(issue.number)}`],
      authors: [issue.user.login, ...issue.assignees.map((a) => a.login)],
      updatedAt: Date.parse(issue.updated_at),
      url: issue.html_url,
      provenance: 'untrusted',
    });

    // Brief per-chunk context line so the body and comment chunks each
    // carry enough structural metadata to embed well on their own.
    // Without this, the body chunk's vector knows the prose but not "this
    // is an open bug issue tagged P0" — which limits retrieval on
    // metadata-heavy queries like "what bugs are open right now".
    const kind = isPr ? 'PR' : 'Issue';
    const statusLine = `${kind} ${ownerRepo}#${String(issue.number)} — ${issue.title}. Status: ${issue.state}.`;
    const labelLine =
      issue.labels.length > 0
        ? ` Labels: ${issue.labels.map((l) => l.name).join(', ')}.`
        : '';
    const contextLine = statusLine + labelLine;

    let chunkPosition = 0;
    // The "header" chunk is the structural metadata summary — title, state,
    // labels, assignees, updated_at — in a form the embedder can read as
    // natural language.
    const headerChunkText = `${contextLine}\n\n${headerText}`;
    if (chunkIsMeaningful(headerChunkText)) {
      chunks.push({
        chunkId: `${docId}#chunk:${String(chunkPosition++)}`,
        docId,
        domain: 'text',
        text: headerChunkText,
        position: chunkPosition,
      });
    }
    if (body.trim().length > 0) {
      const bodyChunkText = `${contextLine}\n\n${body}`;
      if (chunkIsMeaningful(bodyChunkText)) {
        chunks.push({
          chunkId: `${docId}#chunk:${String(chunkPosition++)}`,
          docId,
          domain: 'text',
          text: bodyChunkText,
          position: chunkPosition,
        });
      }
    }

    if (issue.comments_inline !== undefined) {
      for (const comment of issue.comments_inline) {
        if (comment.body.trim().length === 0) continue;
        const commentText = `${contextLine}\n\n${comment.user.login}: ${comment.body}`;
        if (!chunkIsMeaningful(commentText)) continue;
        chunks.push({
          chunkId: `${docId}#chunk:${String(chunkPosition++)}`,
          docId,
          domain: 'text',
          text: commentText,
          position: chunkPosition,
        });
      }
    }
  }

  const lastIssue = issues.at(-1);
  const nextCursor =
    issues.length === pageSize && lastIssue !== undefined
      ? encodeCursor(lastIssue.updated_at)
      : null;

  return { docs, chunks, nextCursor };
}

function canonicalDocId(ownerRepo: string, issue: GithubIssue): string {
  const kind = issue.pull_request !== undefined ? 'pr' : 'issue';
  return `gh:${ownerRepo}#${kind}:${String(issue.number)}`;
}

// Structured metadata summary that goes into the first chunk of every
// issue/PR doc. Kept in compact key=value form for the BM25 ranker — the
// natural-language context line above carries the embedding-friendly
// version. Both shapes appear in the same chunk so the same doc is
// retrievable by either lexical or semantic queries.
function renderHeader(ownerRepo: string, issue: GithubIssue): string {
  const labels = issue.labels.map((l) => l.name).join(', ');
  return [
    `${ownerRepo}#${String(issue.number)}`,
    `state=${issue.state}`,
    labels.length > 0 ? `labels=[${labels}]` : null,
    issue.assignees.length > 0
      ? `assignees=[${issue.assignees.map((a) => a.login).join(', ')}]`
      : null,
    `updated_at=${issue.updated_at}`,
  ]
    .filter((s): s is string => s !== null)
    .join(' | ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

const CURSOR_PREFIX = 'updated-since:';

export function encodeCursor(updatedAt: string): string {
  return `${CURSOR_PREFIX}${updatedAt}`;
}

export function parseCursorSince(cursor: string | null): string | undefined {
  if (cursor === null) return undefined;
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  return cursor.slice(CURSOR_PREFIX.length);
}
