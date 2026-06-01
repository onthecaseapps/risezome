import { describe, expect, it } from 'vitest';
import { buildByAssigneeCountSkill } from '../../../src/skills/github/by_assignee_count.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import type { GithubAccess } from '../../../src/skills/github/source-resolver.js';
import { jsonResponse, SKILL_CTX } from './_live-ctx.js';

const ACCESS: GithubAccess = {
  installations: [{ installationId: 1, token: 'inst_tok', repos: [{ owner: 'o', name: 'r' }] }],
};

/**
 * Route fetch: /search/issues → { total_count }; /users/{login} (try-as-
 * login) → user or status; /search/users → fallback search.
 */
function routedCtx(routes: {
  searchIssuesTotal?: number;
  userLookup?: { status: number; login?: string };
  userSearch?: string[];
}): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/search/issues')) {
      return Promise.resolve(jsonResponse({ total_count: routes.searchIssuesTotal ?? 0 }));
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
  return { client: new GithubClient({ fetchImpl }), resolve: async () => ACCESS };
}

describe('github_by_assignee_count', () => {
  it('returns kind:count with the total_count in the summary', async () => {
    const ctx = routedCtx({ searchIssuesTotal: 5, userLookup: { status: 200, login: 'Nath5' } });
    const result = await buildByAssigneeCountSkill(ctx).handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.kind).toBe('count');
    expect(result.summary).toBe('Nath5 has 5 open issues.');
    expect(result.items).toBeUndefined();
  });

  it('singular noun for a count of 1', async () => {
    const ctx = routedCtx({ searchIssuesTotal: 1, userLookup: { status: 200, login: 'Nath5' } });
    const result = await buildByAssigneeCountSkill(ctx).handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.summary).toBe('Nath5 has 1 open issue.');
  });

  it('zero issues returns "0 open issues"', async () => {
    const ctx = routedCtx({ searchIssuesTotal: 0, userLookup: { status: 200, login: 'Nath5' } });
    const result = await buildByAssigneeCountSkill(ctx).handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.summary).toBe('Nath5 has 0 open issues.');
  });

  it('counts above 30 are exact (no first-page truncation)', async () => {
    const ctx = routedCtx({ searchIssuesTotal: 147, userLookup: { status: 200, login: 'Nath5' } });
    const result = await buildByAssigneeCountSkill(ctx).handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.summary).toBe('Nath5 has 147 open issues.');
    expect(result.summary).not.toContain('+');
  });

  it('person unresolved → graceful summary', async () => {
    const ctx = routedCtx({ userLookup: { status: 404 }, userSearch: [] });
    const result = await buildByAssigneeCountSkill(ctx).handler({ person: 'ghost' }, SKILL_CTX);
    expect(result.summary).toContain("Couldn't find a GitHub user");
  });

  it('search-resolved person includes "Resolved X → Y" prefix', async () => {
    const ctx = routedCtx({ searchIssuesTotal: 1, userLookup: { status: 404 }, userSearch: ['Nath5'] });
    const result = await buildByAssigneeCountSkill(ctx).handler({ person: 'nathan' }, SKILL_CTX);
    expect(result.summary).toContain('Resolved "nathan" → "Nath5"');
    expect(result.summary).toContain('Nath5 has 1 open issue.');
  });
});
