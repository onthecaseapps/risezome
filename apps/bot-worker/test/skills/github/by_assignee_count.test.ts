import { describe, expect, it, vi } from 'vitest';
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

function makeIssue(num: number): unknown {
  return {
    id: num,
    number: num,
    title: `t${String(num)}`,
    state: 'open',
    html_url: '',
    body: null,
    user: { login: 'jamie' },
    assignees: [{ login: 'Nath5' }],
    labels: [],
    created_at: '',
    updated_at: '',
  };
}

describe('github_by_assignee_count', () => {
  it('returns kind:count with the count in the summary', async () => {
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/')) return Promise.resolve(jsonResponse({ login: 'Nath5' }));
      return Promise.resolve(jsonResponse([makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4), makeIssue(5)]));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.kind).toBe('count');
    expect(result.summary).toContain('Nath5 has 5');
    expect(result.summary).toContain('open issues');
    expect(result.items).toBeUndefined();
  });

  it('zero issues returns "0 open issues"', async () => {
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/')) return Promise.resolve(jsonResponse({ login: 'Nath5' }));
      return Promise.resolve(jsonResponse([]));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toContain('0');
  });

  it('30 results triggers first-page truncation annotation', async () => {
    const issues = Array.from({ length: 30 }, (_, i) => makeIssue(i + 1));
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/')) return Promise.resolve(jsonResponse({ login: 'Nath5' }));
      return Promise.resolve(jsonResponse(issues));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'Nath5' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toContain('30+');
    expect(result.summary).toContain('first-page count');
  });

  it('person unresolved → graceful summary, no issues query', async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = (() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(new Response('', { status: 404 }));
      if (callCount === 2) return Promise.resolve(jsonResponse({ items: [] }));
      throw new Error('unexpected call');
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'ghost' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toContain("Couldn't find a GitHub user");
    expect(callCount).toBe(2);
  });

  it('search-resolved person includes "Resolved X → Y" prefix', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = (() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('', { status: 404 }));
      if (call === 2) return Promise.resolve(jsonResponse({ items: [{ login: 'Nath5' }] }));
      return Promise.resolve(jsonResponse([makeIssue(1)]));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildByAssigneeCountSkill(ctx);
    const result = await skill.handler({ person: 'nathan' }, { db: null as never, orgId: 'test-org', now: FAKE_CTX_FN });
    expect(result.summary).toContain('Resolved "nathan" → "Nath5"');
  });

  void vi;
});
