import { adfToText, storageToText } from './atlassian-text';
import type { JiraComment, JiraIssue, ConfluencePage } from './atlassian-client';

/** Stable corpus ids (immutable issue key / page id, namespaced by cloudId). */
export function jiraIssueDocId(cloudId: string, issueKey: string): string {
  return `jira:${cloudId}:${issueKey}`;
}
export function confluencePageDocId(cloudId: string, pageId: string): string {
  return `confluence:${cloudId}:${pageId}`;
}

/**
 * Indexable text for a Jira issue: summary, then the ADF-extracted description,
 * then the comment thread (`author: text`). Blank sections are omitted so empty
 * descriptions / comment-less issues don't add noise.
 */
export function buildIssueDocText(issue: JiraIssue, comments: readonly JiraComment[]): string {
  const parts: string[] = [issue.summary.trim()];

  const desc = adfToText(issue.description).trim();
  if (desc.length > 0) parts.push(desc);

  const lines = comments
    .map((c) => {
      const text = adfToText(c.body).trim();
      if (text.length === 0) return null;
      return `${c.author ?? 'Unknown'}: ${text}`;
    })
    .filter((l): l is string => l !== null);
  if (lines.length > 0) parts.push(`Comments:\n${lines.join('\n')}`);

  return parts.filter((p) => p.length > 0).join('\n\n');
}

/** Indexable text for a Confluence page: title, then the storage-extracted body. */
export function buildPageDocText(page: ConfluencePage): string {
  const parts = [page.title.trim()];
  const body = storageToText(page.bodyStorage).trim();
  if (body.length > 0) parts.push(body);
  return parts.filter((p) => p.length > 0).join('\n\n');
}
