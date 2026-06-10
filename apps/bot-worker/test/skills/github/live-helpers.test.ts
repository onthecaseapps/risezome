import { describe, expect, it } from 'vitest';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { GithubAccess } from '../../../src/skills/github/source-resolver.js';
import {
  accountLogins,
  batchRepoQualifiers,
  searchIssuesCount,
  searchIssuesList,
} from '../../../src/skills/github/live-helpers.js';

function repos(n: number): { owner: string; name: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    owner: 'acme-organization',
    name: `service-repository-${String(i).padStart(2, '0')}`,
  }));
}

describe('batchRepoQualifiers', () => {
  it('keeps every batch joined repo: string within the budget', () => {
    const batches = batchRepoQualifiers(repos(30));
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(230);
      expect(batch.startsWith('repo:')).toBe(true);
    }
    // No repo lost across batches.
    const all = batches.flatMap((b) => b.split(' '));
    expect(all).toHaveLength(30);
  });

  it('a small repo set stays in one batch', () => {
    expect(batchRepoQualifiers(repos(2))).toHaveLength(1);
  });
});

describe('search helpers — multi-batch merge', () => {
  const access: GithubAccess = {
    installations: [{ installationId: 1, token: 't', repos: repos(30) }],
  };

  function searchFetch(onQuery: (q: string) => { total_count: number; items?: unknown[] }): typeof fetch {
    return ((input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const q = url.searchParams.get('q') ?? '';
      expect(q.length).toBeLessThanOrEqual(256); // GitHub's hard query cap
      const body = onQuery(q);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], ...body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
  }

  it('count sums total_count across repo batches and stays under the 256-char cap', async () => {
    let calls = 0;
    const client = new GithubClient({
      fetchImpl: searchFetch(() => {
        calls += 1;
        return { total_count: 5 };
      }),
    });
    const total = await searchIssuesCount(client, access, 'type:issue state:open');
    expect(calls).toBeGreaterThan(1);
    expect(total).toBe(5 * calls);
  });

  it('list merges items across batches, re-sorts by updated desc, caps at limit, sums totals', async () => {
    let batch = 0;
    const client = new GithubClient({
      fetchImpl: searchFetch(() => {
        batch += 1;
        // Interleave updated dates across batches so the merge must re-sort.
        const items = Array.from({ length: 3 }, (_, i) => ({
          number: batch * 10 + i,
          title: `b${String(batch)}-i${String(i)}`,
          state: 'open',
          html_url: 'https://github.com/acme/x/issues/1',
          updated_at: `2026-05-${String(10 + i * 2 + batch).padStart(2, '0')}T00:00:00Z`,
          repository_url: '',
        }));
        return { total_count: 40, items };
      }),
    });
    const { items, totalCount } = await searchIssuesList(client, access, 'type:issue', 4);
    expect(batch).toBeGreaterThan(1);
    expect(items).toHaveLength(4);
    const dates = items.map((i) => i.updated_at);
    expect([...dates].sort().reverse()).toEqual(dates); // newest first across batches
    expect(totalCount).toBe(40 * batch);
  });
});

describe('accountLogins', () => {
  it('returns the unique repo owners across installations', () => {
    const access: GithubAccess = {
      installations: [
        {
          installationId: 1,
          token: 'a',
          repos: [
            { owner: 'acme', name: 'one' },
            { owner: 'acme', name: 'two' },
          ],
        },
        { installationId: 2, token: 'b', repos: [{ owner: 'globex', name: 'three' }] },
      ],
    };
    expect(accountLogins(access).sort()).toEqual(['acme', 'globex']);
  });
});
