import { describe, expect, it } from 'vitest';
import { buildByAssigneeCountSkill } from '../../../src/skills/github/by_assignee_count.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { AuthResult } from '../../../src/skills/github/connector-errors.js';

const AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };
const FAKE_CTX_FN = (): never => {
  throw new Error('not invoked');
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Route fetch by URL. The count now comes from the GitHub Search API
 * (/search/issues → { total_count }), not a /repos/.../issues list.
 * Person resolution hits /users/{login} (try-as-login) then
 * /search/users (fallback).
 */
function routedFetch(routes: {
  searchIssuesTotal?: number;
  userLookup?: { status: number; login?: string };
  userSearch?: string[];
}): typeof fetch {
  return ((input: string | URL | Request) => {
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
  }) as typeof fetch;
}

function ctxWith(fetchImpl: typeof fetch): LiveSkillContext {
  return {
    client: new GithubClient({ fetchImpl }),
    auth: AUTH,
    repo: { owner: 'o', name: 'r' },
  };
}

describe('github_by_assignee_count', () => {
  it('returns kind:count with the total_count in the summary', async () => {
    const ctx = ctxWith(routedFetch({ searchIssuesTotal: 5, userLookup: { status: 200, login: 'Nath5' } }));
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.kind).toBe('count');
    expect(result.summary).toBe('Nath5 has 5 open issues.');
    expect(result.items).toBeUndefined();
  });

  it('singular noun for a count of 1', async () => {
    const ctx = ctxWith(routedFetch({ searchIssuesTotal: 1, userLookup: { status: 200, login: 'Nath5' } }));
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toBe('Nath5 has 1 open issue.');
  });

  it('zero issues returns "0 open issues"', async () => {
    const ctx = ctxWith(routedFetch({ searchIssuesTotal: 0, userLookup: { status: 200, login: 'Nath5' } }));
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toBe('Nath5 has 0 open issues.');
  });

  it('counts above 30 are exact (no first-page truncation)', async () => {
    const ctx = ctxWith(routedFetch({ searchIssuesTotal: 147, userLookup: { status: 200, login: 'Nath5' } }));
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toBe('Nath5 has 147 open issues.');
    expect(result.summary).not.toContain('+');
  });

  it('person unresolved → graceful summary, no issues query', async () => {
    const ctx = ctxWith(routedFetch({ userLookup: { status: 404 }, userSearch: [] }));
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'ghost' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toContain("Couldn't find a GitHub user");
  });

  it('search-resolved person includes "Resolved X → Y" prefix', async () => {
    const ctx = ctxWith(routedFetch({ searchIssuesTotal: 1, userLookup: { status: 404 }, userSearch: ['Nath5'] }));
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'nathan' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toContain('Resolved "nathan" → "Nath5"');
    expect(result.summary).toContain('Nath5 has 1 open issue.');
  });
});
