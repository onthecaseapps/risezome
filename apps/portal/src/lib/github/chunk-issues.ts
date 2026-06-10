import { orgScopedDocId } from '../../../app/_lib/doc-id';

/**
 * Pure data transformation: GitHub issue/PR → canonical doc + chunks
 * ready to upsert into the Postgres corpus.
 *
 * Ported from `apps/daemon/src/connectors/github/pull-delta.ts`. The
 * chunk-text format ("Issue owner/repo#42 — title. Status: open.
 * Labels: bug, p0.") is the load-bearing contract: U6's corpus skills
 * FTS-match against `"Status open"` etc., so the wording here must
 * stay byte-equal to the daemon's output for representative fixtures.
 *
 * Comment + event-timeline ingestion is deferred — see scope boundaries
 * in docs/plans/2026-05-31-003. Each issue produces a header chunk +
 * an optional body chunk; nothing else.
 */

import type { GithubIssue } from './issue-types.js';

// Drop chunks shorter than this so embedding budget isn't spent on
// near-empty rows. Mirrors `MIN_CHUNK_CHARS` in
// `apps/daemon/src/connectors/github/chunk-shared.ts`.
export const MIN_CHUNK_CHARS = 80;

export interface CanonicalIssueDoc {
  /** Stable, org-scoped corpus id:
   *  `{orgId}:gh:{owner/repo}#{issue|pr}:{number}` (see orgScopedDocId). */
  readonly docId: string;
  readonly type: 'issue' | 'pull-request';
  readonly title: string;
  readonly bodySummary: string;
  readonly entities: readonly string[];
  readonly authors: readonly string[];
  readonly updatedAt: string;
  readonly url: string;
}

export interface CanonicalIssueChunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly domain: 'text';
  readonly text: string;
  readonly position: number;
}

export interface ChunkedIssue {
  readonly doc: CanonicalIssueDoc;
  readonly chunks: readonly CanonicalIssueChunk[];
}

export function chunkIssue(orgId: string, ownerRepo: string, issue: GithubIssue): ChunkedIssue {
  const docId = canonicalDocId(orgId, ownerRepo, issue);
  const isPr = issue.pull_request !== undefined;
  const body = issue.body ?? '';

  const doc: CanonicalIssueDoc = {
    docId,
    type: isPr ? 'pull-request' : 'issue',
    title: issue.title,
    bodySummary: truncate(body, 240),
    entities: [`${ownerRepo}#${String(issue.number)}`],
    authors: [issue.user.login, ...issue.assignees.map((a) => a.login)],
    updatedAt: issue.updated_at,
    url: issue.html_url,
  };

  // Status + labels phrase line — load-bearing contract for U6's FTS.
  // Same wording (and same punctuation) as
  // `apps/daemon/src/connectors/github/pull-delta.ts:62-67`.
  const kind = isPr ? 'PR' : 'Issue';
  const statusLine = `${kind} ${ownerRepo}#${String(issue.number)} — ${issue.title}. Status: ${issue.state}.`;
  const labelLine =
    issue.labels.length > 0
      ? ` Labels: ${issue.labels.map((l) => l.name).join(', ')}.`
      : '';
  const contextLine = statusLine + labelLine;

  const chunks: CanonicalIssueChunk[] = [];
  let position = 0;

  const headerText = renderHeader(ownerRepo, issue);
  const headerChunkText = `${contextLine}\n\n${headerText}`;
  if (chunkIsMeaningful(headerChunkText)) {
    chunks.push({
      chunkId: `${docId}#chunk:${String(position)}`,
      docId,
      domain: 'text',
      text: headerChunkText,
      position,
    });
    position += 1;
  }

  if (body.trim().length > 0) {
    const bodyChunkText = `${contextLine}\n\n${body}`;
    if (chunkIsMeaningful(bodyChunkText)) {
      chunks.push({
        chunkId: `${docId}#chunk:${String(position)}`,
        docId,
        domain: 'text',
        text: bodyChunkText,
        position,
      });
      position += 1;
    }
  }

  return { doc, chunks };
}

export function canonicalDocId(orgId: string, ownerRepo: string, issue: GithubIssue): string {
  const kind = issue.pull_request !== undefined ? 'pr' : 'issue';
  return orgScopedDocId(orgId, `gh:${ownerRepo}#${kind}:${String(issue.number)}`);
}

/**
 * Compact key=value summary chunk, written alongside the natural-
 * language status line. The lexical (BM25) leg of corpus search hits
 * the key=value form; the semantic leg hits the prose status line.
 * Both shapes appear in the same chunk so the same doc is retrievable
 * by either query type.
 */
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

export function chunkIsMeaningful(text: string): boolean {
  return text.trim().length >= MIN_CHUNK_CHARS;
}
