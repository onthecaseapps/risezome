import { describe, expect, it, vi } from 'vitest';
import { buildIssueAssigneesSkill } from '../../../src/skills/github/issue_assignees.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import { SkillExecutionError } from '@risezome/engine/skills';
import type { AuthResult } from '../../../src/skills/github/connector-errors.js';

const AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };

function ctxWith(fetchImpl: typeof fetch): LiveSkillContext {
  const client = new GithubClient({ fetchImpl });
  return { client, auth: AUTH, repo: { owner: 'o', name: 'r' } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FAKE_CTX_FN = (): never => {
  throw new Error('signal should not be invoked in these tests');
};

describe('github_issue_assignees', () => {
  it('returns skill with the right name, source, and required input', () => {
    const skill = buildIssueAssigneesSkill(ctxWith(vi.fn() as unknown as typeof fetch));
    expect(skill.name).toBe('github_issue_assignees');
    expect(skill.source).toBe('github');
    expect(skill.inputSchema.required).toEqual(['issue_number']);
    const props = skill.inputSchema.properties;
    expect(props['issue_number']?.type).toBe('integer');
    if (props['issue_number']?.type === 'integer') {
      expect(props['issue_number'].minimum).toBe(1);
    }
  });

  it('returns detail summary listing assignees when issue has them', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          id: 1,
          number: 14,
          title: 'Auth refactor',
          state: 'open',
          html_url: 'https://github.com/o/r/issues/14',
          body: 'body',
          user: { login: 'jamie' },
          assignees: [{ login: 'Nath5' }, { login: 'alice' }],
          labels: [],
          created_at: '2026-05-28T12:00:00Z',
          updated_at: '2026-05-29T12:00:00Z',
        }),
      ),
    );
    const skill = buildIssueAssigneesSkill(ctxWith(fetchImpl as unknown as typeof fetch));
    const result = await skill.handler({ issue_number: 14 }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.kind).toBe('detail');
    expect(result.summary).toContain('#14');
    expect(result.summary).toContain('Auth refactor');
    expect(result.summary).toContain('Nath5');
    expect(result.summary).toContain('alice');
    expect(result.items).toHaveLength(2);
    expect(result.items?.[0]?.url).toBe('https://github.com/Nath5');
  });

  it('returns "no current assignees" when assignees array is empty', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          id: 1,
          number: 7,
          title: 'Unassigned',
          state: 'open',
          html_url: 'https://github.com/o/r/issues/7',
          body: null,
          user: { login: 'jamie' },
          assignees: [],
          labels: [],
          created_at: '',
          updated_at: '',
        }),
      ),
    );
    const skill = buildIssueAssigneesSkill(ctxWith(fetchImpl as unknown as typeof fetch));
    const result = await skill.handler({ issue_number: 7 }, { db: null as never, now: FAKE_CTX_FN });
    expect(result.summary).toContain('no current assignees');
    expect(result.items).toBeUndefined();
  });

  it('hits /repos/{owner}/{name}/issues/{number} with the configured repo', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn((input) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return Promise.resolve(
        jsonResponse({
          id: 1,
          number: 99,
          title: 't',
          state: 'open',
          html_url: '',
          body: null,
          user: { login: 'x' },
          assignees: [],
          labels: [],
          created_at: '',
          updated_at: '',
        }),
      );
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      auth: AUTH,
      repo: { owner: 'Nath5', name: 'upwell' },
    };
    const skill = buildIssueAssigneesSkill(ctx);
    await skill.handler({ issue_number: 99 }, { db: null as never, now: FAKE_CTX_FN });
    expect(capturedUrl).toContain('/repos/Nath5/upwell/issues/99');
  });

  it('404 maps to SkillExecutionError code=not-found', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    const skill = buildIssueAssigneesSkill(ctxWith(fetchImpl as unknown as typeof fetch));
    await expect(
      skill.handler({ issue_number: 999 }, { db: null as never, now: FAKE_CTX_FN }),
    ).rejects.toMatchObject({
      executionCode: 'not-found',
    });
  });

  it('rate-limit maps to SkillExecutionError code=rate-limit', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    );
    const skill = buildIssueAssigneesSkill(ctxWith(fetchImpl as unknown as typeof fetch));
    await expect(
      skill.handler({ issue_number: 14 }, { db: null as never, now: FAKE_CTX_FN }),
    ).rejects.toMatchObject({ executionCode: 'rate-limit' });
  });

  it('handler throws SkillExecutionError instance (not plain Error)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    const skill = buildIssueAssigneesSkill(ctxWith(fetchImpl as unknown as typeof fetch));
    await expect(
      skill.handler({ issue_number: 14 }, { db: null as never, now: FAKE_CTX_FN }),
    ).rejects.toBeInstanceOf(SkillExecutionError);
  });
});
