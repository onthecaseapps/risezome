/**
 * Atlassian read client for Jira issues and Confluence pages. cloudId-namespaced
 * (api.atlassian.com/ex/{product}/{cloudId}/…), with Retry-After/429 backoff and
 * 401 → AtlassianAuthError. The caller supplies a valid access token (resolved
 * via the token manager).
 *
 * Pagination differs by endpoint: Jira projects/comments use startAt; Jira issue
 * search uses nextPageToken (with a seen-keys loop guard for the known
 * repeating-token bug); Confluence v2 uses cursor (_links.next).
 */

import { ATLASSIAN_API_BASE, AtlassianAuthError } from './atlassian';

const MAX_RETRIES = 4;
const MAX_ISSUE_PAGES = 1000; // hard safeguard against the /search/jql loop bug

/**
 * Thrown when issue pagination terminates WITHOUT a clean server-confirmed end
 * (repeating-token loop bug, or the page cap). It signals "this set is partial"
 * so the connector index fails + retries rather than treating a truncated set
 * as authoritative and pruning the issues it never reached. NOT an auth error,
 * so runConnectorIndex re-throws it (→ Inngest retry → onFailure if persistent).
 */
export class JiraPartialFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraPartialFetchError';
  }
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface AtlassianContext {
  readonly accessToken: string;
  readonly cloudId: string;
  readonly sleep?: Sleep;
}

export interface JiraProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface JiraIssue {
  readonly key: string;
  readonly summary: string;
  /** ADF description (or null). */
  readonly description: unknown;
  /** Status name (e.g. "In Progress"), when returned. */
  readonly status?: string | null;
  /** Issue type name (e.g. "Bug"), when returned. */
  readonly issueType?: string | null;
  /** Assignee display name, when returned. */
  readonly assignee?: string | null;
  /** The issue's `fields.updated` timestamp, when returned. */
  readonly updated?: string | null;
}

export interface JiraComment {
  readonly id: string;
  /** ADF comment body. */
  readonly body: unknown;
  readonly author: string | null;
}

export interface ConfluenceSpace {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface ConfluencePage {
  readonly id: string;
  readonly title: string;
  /** Storage-format body. */
  readonly bodyStorage: string;
  /** Last-modified timestamp from the page's version, when returned. */
  readonly updatedAt?: string | null;
}

/** Authenticated GET against a fully-formed `api.atlassian.com/ex/...` path. */
async function atlassianGet<T>(absolutePath: string, ctx: AtlassianContext): Promise<T> {
  const sleep = ctx.sleep ?? realSleep;
  const url = absolutePath.startsWith('http') ? absolutePath : `${ATLASSIAN_API_BASE}${absolutePath}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${ctx.accessToken}`, accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) throw new AtlassianAuthError();
    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error('Atlassian rate limit exceeded after retries');
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      const baseMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1);
      const jitter = Math.floor(baseMs * 0.3);
      await sleep(baseMs + jitter);
      continue;
    }
    if (!res.ok) throw new Error(`Atlassian GET ${url} failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }
  throw new Error('Atlassian GET exhausted retries');
}

function jiraPath(cloudId: string, path: string): string {
  return `${ATLASSIAN_API_BASE}/ex/jira/${cloudId}${path}`;
}
function confluencePath(cloudId: string, path: string): string {
  return `${ATLASSIAN_API_BASE}/ex/confluence/${cloudId}${path}`;
}

/** All projects accessible to the token (startAt pagination via isLast). */
export async function listJiraProjects(ctx: AtlassianContext): Promise<JiraProject[]> {
  const out: JiraProject[] = [];
  let startAt = 0;
  for (;;) {
    const page = await atlassianGet<{ values: Array<{ id: string; key: string; name: string }>; isLast: boolean }>(
      jiraPath(ctx.cloudId, `/rest/api/3/project/search?maxResults=50&startAt=${startAt}`),
      ctx,
    );
    out.push(...page.values.map((p) => ({ id: p.id, key: p.key, name: p.name })));
    if (page.isLast || page.values.length === 0) break;
    startAt += page.values.length;
  }
  return out;
}

/**
 * Issues in a project via the current /search/jql endpoint (nextPageToken, no
 * total). Guards the known repeating-token loop bug by tracking seen keys + a
 * hard page cap.
 */
export async function searchJiraIssues(projectKey: string, ctx: AtlassianContext): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  const seen = new Set<string>();
  let nextPageToken: string | undefined;
  const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
  const fields = 'summary,description,status,issuetype,assignee,key,updated';

  for (let pages = 0; pages < MAX_ISSUE_PAGES; pages += 1) {
    // nextPageToken is server-issued and may contain URL-active characters —
    // encode it so it survives the query string intact.
    const q = `jql=${jql}&fields=${fields}&maxResults=50${nextPageToken !== undefined ? `&nextPageToken=${encodeURIComponent(nextPageToken)}` : ''}`;
    const page = await atlassianGet<{
      issues: Array<{
        key: string;
        fields: {
          summary?: string;
          description?: unknown;
          status?: { name?: string } | null;
          issuetype?: { name?: string } | null;
          assignee?: { displayName?: string } | null;
          updated?: string | null;
        };
      }>;
      nextPageToken?: string;
      isLast?: boolean;
    }>(jiraPath(ctx.cloudId, `/rest/api/3/search/jql?${q}`), ctx);

    let added = 0;
    for (const issue of page.issues) {
      if (seen.has(issue.key)) continue; // loop-bug guard: repeated content → stop
      seen.add(issue.key);
      out.push({
        key: issue.key,
        summary: issue.fields.summary ?? '',
        description: issue.fields.description ?? null,
        status: issue.fields.status?.name ?? null,
        issueType: issue.fields.issuetype?.name ?? null,
        assignee: issue.fields.assignee?.displayName ?? null,
        updated: issue.fields.updated ?? null,
      });
      added += 1;
    }
    // Clean completion: the server says this is the last page (or offers no
    // continuation). Return the full set.
    if (page.isLast === true || page.nextPageToken === undefined) return out;
    // PARTIAL termination. `added === 0` while a nextPageToken is still offered
    // is the known repeating-token loop bug: the server keeps handing us a
    // continuation token that returns already-seen content, so we CANNOT
    // conclude we've seen every issue. Returning the partial set here is what
    // let the indexer's delta prune DELETE every issue we simply failed to page
    // to (fetchEntities is contracted to THROW on partial, and the reconcile
    // prune trusts that). Throw so the run fails + retries instead of pruning.
    if (added === 0) {
      throw new JiraPartialFetchError(
        `searchJiraIssues(${projectKey}): pagination loop (token repeats, ${String(out.length)} collected) — refusing to report a partial set as complete`,
      );
    }
    nextPageToken = page.nextPageToken;
  }
  // Exhausted the hard page cap without a clean end → also partial.
  throw new JiraPartialFetchError(
    `searchJiraIssues(${projectKey}): exceeded ${String(MAX_ISSUE_PAGES)} pages (${String(out.length)} collected) — partial set, refusing to prune`,
  );
}

/** All comments on an issue (startAt pagination). */
export async function fetchJiraComments(issueKey: string, ctx: AtlassianContext): Promise<JiraComment[]> {
  const out: JiraComment[] = [];
  let startAt = 0;
  for (;;) {
    const page = await atlassianGet<{
      comments: Array<{ id: string; body?: unknown; author?: { displayName?: string } }>;
      total: number;
      maxResults: number;
    }>(jiraPath(ctx.cloudId, `/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=100`), ctx);
    for (const c of page.comments) {
      out.push({ id: c.id, body: c.body ?? null, author: c.author?.displayName ?? null });
    }
    startAt += page.comments.length;
    if (page.comments.length === 0 || startAt >= page.total) break;
  }
  return out;
}

/** Confluence spaces (v2 cursor pagination). */
export async function listConfluenceSpaces(ctx: AtlassianContext): Promise<ConfluenceSpace[]> {
  const out: ConfluenceSpace[] = [];
  let path: string | undefined = confluencePath(ctx.cloudId, '/wiki/api/v2/spaces?limit=100');
  while (path !== undefined) {
    const page: { results: Array<{ id: string; key: string; name: string }>; _links?: { next?: string } } =
      await atlassianGet(path, ctx);
    out.push(...page.results.map((s) => ({ id: s.id, key: s.key, name: s.name })));
    path = nextLink(page._links?.next, ctx.cloudId, 'confluence');
  }
  return out;
}

/** Current (non-archived) pages in a space with storage-format body (v2 cursor). */
export async function listConfluencePages(spaceId: string, ctx: AtlassianContext): Promise<ConfluencePage[]> {
  const out: ConfluencePage[] = [];
  let path: string | undefined = confluencePath(
    ctx.cloudId,
    `/wiki/api/v2/pages?space-id=${spaceId}&status=current&body-format=storage&limit=100`,
  );
  while (path !== undefined) {
    const page: {
      results: Array<{
        id: string;
        title: string;
        body?: { storage?: { value?: string } };
        // v2 returns `version.createdAt`; `when` covers any v1-shaped payloads.
        version?: { createdAt?: string; when?: string } | null;
      }>;
      _links?: { next?: string };
    } = await atlassianGet(path, ctx);
    out.push(
      ...page.results.map((p) => ({
        id: p.id,
        title: p.title,
        bodyStorage: p.body?.storage?.value ?? '',
        updatedAt: p.version?.createdAt ?? p.version?.when ?? null,
      })),
    );
    path = nextLink(page._links?.next, ctx.cloudId, 'confluence');
  }
  return out;
}

/** Resolve a relative `_links.next` to an absolute cloudId-namespaced URL. */
function nextLink(next: string | undefined, cloudId: string, product: 'confluence'): string | undefined {
  if (next === undefined || next.length === 0) return undefined;
  if (next.startsWith('http')) return next;
  // v2 next is like "/wiki/api/v2/pages?cursor=…"
  return `${ATLASSIAN_API_BASE}/ex/${product}/${cloudId}${next}`;
}
