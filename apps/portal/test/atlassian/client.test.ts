import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchJiraComments,
  listConfluencePages,
  listJiraProjects,
  searchJiraIssues,
  JiraPartialFetchError,
  type AtlassianContext,
} from '../../app/_lib/atlassian-client';
import { AtlassianAuthError } from '../../app/_lib/atlassian';

const ctx: AtlassianContext = { accessToken: 'AT', cloudId: 'cloud', sleep: async () => undefined };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => vi.restoreAllMocks());

describe('listJiraProjects', () => {
  it('paginates via startAt/isLast', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return json({ values: [{ id: '1', key: 'A', name: 'Alpha' }], isLast: false });
      return json({ values: [{ id: '2', key: 'B', name: 'Beta' }], isLast: true });
    });
    const projects = await listJiraProjects(ctx);
    expect(projects.map((p) => p.key)).toEqual(['A', 'B']);
  });
});

describe('searchJiraIssues', () => {
  it('maps issues and stops on isLast', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        issues: [
          { key: 'P-1', fields: { summary: 'first', description: { type: 'doc' } } },
          { key: 'P-2', fields: { summary: 'second', description: null } },
        ],
        isLast: true,
      }),
    );
    const issues = await searchJiraIssues('P', ctx);
    expect(issues.map((i) => i.key)).toEqual(['P-1', 'P-2']);
    expect(issues[0]?.summary).toBe('first');
  });

  it('THROWS JiraPartialFetchError on the repeating-token loop bug (must not report a partial set as complete)', async () => {
    // Always returns the same page with a nextPageToken (simulating the bug).
    // The seen-keys guard stops the infinite loop, but the set is PARTIAL — the
    // server still claims more pages exist — so it must throw rather than return
    // a truncated list the indexer would treat as authoritative and prune to.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json({ issues: [{ key: 'P-1', fields: { summary: 's' } }], nextPageToken: 'same', isLast: false }),
    );
    await expect(searchJiraIssues('P', ctx)).rejects.toBeInstanceOf(JiraPartialFetchError);
  });
});

describe('fetchJiraComments', () => {
  it('maps comment body + author and paginates to total', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        comments: [{ id: 'a1', body: { type: 'doc' }, author: { displayName: 'Priya' } }],
        total: 1,
        maxResults: 100,
      }),
    );
    const comments = await fetchJiraComments('P-1', ctx);
    expect(comments).toEqual([{ id: 'a1', body: { type: 'doc' }, author: 'Priya' }]);
  });
});

describe('listConfluencePages', () => {
  it('follows the v2 cursor (_links.next) until absent', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return json({
          results: [{ id: 'pg1', title: 'One', body: { storage: { value: '<p>a</p>' } } }],
          _links: { next: '/wiki/api/v2/pages?cursor=NEXT' },
        });
      }
      return json({ results: [{ id: 'pg2', title: 'Two', body: { storage: { value: '<p>b</p>' } } }], _links: {} });
    });
    const pages = await listConfluencePages('space1', ctx);
    expect(pages.map((p) => p.id)).toEqual(['pg1', 'pg2']);
    expect(pages[0]?.bodyStorage).toBe('<p>a</p>');
  });
});

describe('auth + rate-limit handling', () => {
  it('backs off on 429 (Retry-After) then retries', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response('rate', { status: 429, headers: { 'retry-after': '0' } });
      return json({ values: [{ id: '1', key: 'A', name: 'Alpha' }], isLast: true });
    });
    const projects = await listJiraProjects(ctx);
    expect(call).toBe(2);
    expect(projects).toHaveLength(1);
  });

  it('raises AtlassianAuthError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
    await expect(listJiraProjects(ctx)).rejects.toBeInstanceOf(AtlassianAuthError);
  });
});
