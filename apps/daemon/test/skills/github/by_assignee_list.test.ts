import { describe, expect, it, vi } from 'vitest';
import { buildByAssigneeListSkill } from '../../../src/skills/github/by_assignee_list.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { GithubClient } from '../../../src/connectors/github/client.js';
import type { AuthResult } from '../../../src/connectors/contract.js';

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

function makeIssue(num: number, title: string): unknown {
  return {
    id: num,
    number: num,
    title,
    state: 'open',
    html_url: `https://github.com/o/r/issues/${String(num)}`,
    body: null,
    user: { login: 'jamie' },
    assignees: [{ login: 'Nath5' }],
    labels: [],
    created_at: '',
    updated_at: '',
  };
}

describe('github_by_assignee_list', () => {
  it('literal resolution + list of 3 issues', async () => {
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/')) return Promise.resolve(jsonResponse({ login: 'Nath5' }));
      return Promise.resolve(
        jsonResponse([makeIssue(1, 'one'), makeIssue(2, 'two'), makeIssue(3, 'three')]),
      );
    }) as typeof fetch;
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.kind).toBe('list');
    expect(result.summary).toContain('Nath5');
    expect(result.summary).toContain('3 open issues');
    expect(result.summary).not.toContain('Resolved'); // literal — no resolution note
    expect(result.items).toHaveLength(3);
    expect(result.items?.[0]?.subtitle).toBe('#1 · open');
  });

  it('search-fallback resolution includes "Resolved X → Y" in summary', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = (() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('', { status: 404 })); // literal 404
      if (call === 2) return Promise.resolve(jsonResponse({ items: [{ login: 'Nath5' }] })); // search hit
      return Promise.resolve(jsonResponse([makeIssue(1, 'one')])); // issues query
    }) as typeof fetch;
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'nathan' }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.summary).toContain('Resolved "nathan" → "Nath5"');
    expect(result.summary).toContain('1 open issues');
  });

  it('person unresolved → summary explains, no issues query fires', async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = (() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(new Response('', { status: 404 })); // literal 404
      if (callCount === 2) return Promise.resolve(jsonResponse({ items: [] })); // search empty
      throw new Error('no further calls should happen');
    }) as typeof fetch;
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'ghost' }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.summary).toContain("Couldn't find a GitHub user matching");
    expect(result.summary).toContain('"ghost"');
    expect(result.items).toBeUndefined();
    expect(callCount).toBe(2); // literal + search, but no issues call
  });

  it('empty result list summary says "0 open issues"', async () => {
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/')) return Promise.resolve(jsonResponse({ login: 'Nath5' }));
      return Promise.resolve(jsonResponse([]));
    }) as typeof fetch;
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.summary).toContain('0 open issues');
    expect(result.items).toBeUndefined();
  });

  it('first-page truncation annotation when 30 items returned', async () => {
    const issues = Array.from({ length: 30 }, (_, i) => makeIssue(i + 1, `t${String(i + 1)}`));
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/')) return Promise.resolve(jsonResponse({ login: 'Nath5' }));
      return Promise.resolve(jsonResponse(issues));
    }) as typeof fetch;
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeListSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.summary).toContain('(showing first 30)');
  });

  it('rate-limit during literal lookup propagates as rate-limit code', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        new Response('', { status: 429, headers: { 'retry-after': '60' } }),
      )) as typeof fetch;
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeListSkill(ctx);
    await expect(
      skill.handler({ person: 'Nath5' }, { db: null as never, now: FAKE_CTX_FN }),
    ).rejects.toMatchObject({ executionCode: 'rate-limit' });
  });

  void vi;
});
