import { describe, expect, it } from 'vitest';
import { buildByAssigneeListSkill } from '../../../src/skills/github/by_assignee_list.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import type { GithubAccess } from '../../../src/skills/github/source-resolver.js';
import { jsonResponse, SKILL_CTX } from './_live-ctx.js';

const ACCESS: GithubAccess = {
  installations: [{ installationId: 1, token: 'inst_tok', repos: [{ owner: 'o', name: 'r' }] }],
};

/** Search-API item shape (the list now goes through /search/issues). */
function searchItem(num: number, title: string): unknown {
  return {
    number: num,
    title,
    state: 'open',
    html_url: `https://github.com/o/r/issues/${String(num)}`,
    updated_at: `2026-05-${String(10 + num).padStart(2, '0')}T00:00:00Z`,
    repository_url: 'https://api.github.com/repos/o/r',
    user: { login: 'jamie' },
    assignees: [{ login: 'Nath5' }],
  };
}

/**
 * Route fetch: /users/{login} (try-as-login), /search/users (fallback),
 * /search/issues (the assignee list).
 */
function routedCtx(routes: {
  userLookup?: { status: number; login?: string };
  userSearch?: string[];
  items?: unknown[];
  rateLimit?: boolean;
}): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (routes.rateLimit === true) {
      return Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    }
    if (url.includes('/search/issues')) {
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
  }) as typeof fetch;
  return { client: new GithubClient({ fetchImpl }), resolve: async () => ACCESS };
}

describe('github_by_assignee_list', () => {
  it('literal resolution + list of 3 issues', async () => {
    const ctx = routedCtx({
      userLookup: { status: 200, login: 'Nath5' },
      items: [searchItem(1, 'one'), searchItem(2, 'two'), searchItem(3, 'three')],
    });
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.kind).toBe('list');
    expect(result.summary).toContain('Nath5');
    expect(result.summary).toContain('3 open issues');
    expect(result.summary).not.toContain('Resolved');
    expect(result.items).toHaveLength(3);
    expect(result.items?.map((i) => i.subtitle)).toContain('#3 · open');
  });

  it('search-fallback resolution includes "Resolved X → Y" in summary', async () => {
    const ctx = routedCtx({
      userLookup: { status: 404 },
      userSearch: ['Nath5'],
      items: [searchItem(1, 'one')],
    });
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'nathan' }, SKILL_CTX);
    expect(result.summary).toContain('Resolved "nathan" → "Nath5"');
    expect(result.summary).toContain('1 open issues');
  });

  it('person unresolved → summary explains, no issues query fires', async () => {
    const ctx = routedCtx({ userLookup: { status: 404 }, userSearch: [] });
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'ghost' }, SKILL_CTX);
    expect(result.summary).toContain("Couldn't find a GitHub user matching");
    expect(result.summary).toContain('"ghost"');
    expect(result.items).toBeUndefined();
  });

  it('empty result list summary says "0 open issues"', async () => {
    const ctx = routedCtx({ userLookup: { status: 200, login: 'Nath5' }, items: [] });
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.summary).toContain('0 open issues');
    expect(result.items).toBeUndefined();
  });

  it('truncation annotation when the result hits the 25-item cap', async () => {
    const items = Array.from({ length: 25 }, (_, i) => searchItem(i + 1, `t${String(i + 1)}`));
    const ctx = routedCtx({ userLookup: { status: 200, login: 'Nath5' }, items });
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, SKILL_CTX);
    expect(result.summary).toContain('(showing first 25)');
  });

  it('rate-limit during literal lookup propagates as rate-limit code', async () => {
    const ctx = routedCtx({ rateLimit: true });
    const skill = buildByAssigneeListSkill(ctx);
    await expect(skill.handler({ person: 'Nath5' }, SKILL_CTX)).rejects.toMatchObject({
      executionCode: 'rate-limit',
    });
  });
});
