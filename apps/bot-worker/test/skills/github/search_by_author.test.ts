import { describe, expect, it } from 'vitest';
import { buildSearchByAuthorSkill } from '../../../src/skills/github/search_by_author.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { jsonResponse, SKILL_CTX } from './_live-ctx.js';

function searchItem(num: number, title: string): unknown {
  return {
    number: num,
    title,
    state: 'open',
    html_url: `https://github.com/o/r/issues/${String(num)}`,
    updated_at: `2026-05-${String(10 + num).padStart(2, '0')}T00:00:00Z`,
    repository_url: 'https://api.github.com/repos/o/r',
    user: { login: 'Nath5' },
  };
}

/** Route /users/{login} (try-as-login), /search/users (fallback), /search/issues. */
function routedCtx(routes: {
  userLookup?: { status: number; login?: string };
  userSearch?: string[];
  items?: unknown[];
  onIssuesQuery?: (q: string) => void;
}): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/search/issues')) {
      routes.onIssuesQuery?.(new URL(url).searchParams.get('q') ?? '');
      return Promise.resolve(jsonResponse({ items: routes.items ?? [] }));
    }
    if (url.includes('/search/users')) {
      return Promise.resolve(jsonResponse({ items: (routes.userSearch ?? []).map((login) => ({ login })) }));
    }
    if (url.includes('/users/')) {
      const u = routes.userLookup ?? { status: 200, login: 'Nath5' };
      if (u.status !== 200) return Promise.resolve(new Response('', { status: u.status }));
      return Promise.resolve(jsonResponse({ login: u.login }));
    }
    throw new Error(`unexpected url: ${url}`);
  });
  return {
    client: new GithubClient({ fetchImpl }),
    resolve: async () => ({ installations: [{ installationId: 1, token: 't', repos: [{ owner: 'o', name: 'r' }] }] }),
  };
}

describe('github_by_author (live Search API)', () => {
  it('literal resolution → author: qualifier + list', async () => {
    let q = '';
    const skill = buildSearchByAuthorSkill(
      routedCtx({ items: [searchItem(1, 'one'), searchItem(2, 'two')], onIssuesQuery: (s) => (q = s) }),
    );
    const result = await skill.handler({ login: 'Nath5' }, SKILL_CTX);
    expect(q).toContain('author:Nath5');
    expect(result.summary).toContain('authored by Nath5');
    expect(result.summary).not.toContain('Resolved');
    expect(result.items).toHaveLength(2);
    expect(result.items?.map((i) => i.subtitle)).toContain('#1 · open');
  });

  it('search-fallback resolution includes "Resolved X → Y"', async () => {
    const skill = buildSearchByAuthorSkill({
      ...routedCtx({ userLookup: { status: 404 }, userSearch: ['Nath5'], items: [searchItem(1, 'one')] }),
    });
    const result = await skill.handler({ login: 'nathan' }, SKILL_CTX);
    expect(result.summary).toContain('Resolved "nathan" → "Nath5"');
  });

  it('unresolved person → explains, no issues query', async () => {
    const skill = buildSearchByAuthorSkill(routedCtx({ userLookup: { status: 404 }, userSearch: [] }));
    const result = await skill.handler({ login: 'ghost' }, SKILL_CTX);
    expect(result.summary).toContain("Couldn't find a GitHub user matching");
    expect(result.items).toBeUndefined();
  });

  it('passes through state/type filters into the qualifier', async () => {
    let q = '';
    const skill = buildSearchByAuthorSkill(routedCtx({ items: [], onIssuesQuery: (s) => (q = s) }));
    await skill.handler({ login: 'Nath5', type: 'pull-request', state: 'open' }, SKILL_CTX);
    expect(q).toContain('type:pr');
    expect(q).toContain('state:open');
    expect(q).toContain('author:Nath5');
  });
});
