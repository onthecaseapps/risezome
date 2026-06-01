import { describe, expect, it, vi } from 'vitest';
import { buildIssueAssigneesSkill } from '../../../src/skills/github/issue_assignees.js';
import { SkillExecutionError } from '@risezome/engine/skills';
import { jsonResponse, liveCtx, liveCtxNoSource, SKILL_CTX } from './_live-ctx.js';

function issueResponse(over: Record<string, unknown> = {}): Response {
  return jsonResponse({
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
    ...over,
  });
}

describe('github_issue_assignees', () => {
  it('returns skill with the right name, source, and required input', () => {
    const skill = buildIssueAssigneesSkill(liveCtx(vi.fn()));
    expect(skill.name).toBe('github_issue_assignees');
    expect(skill.source).toBe('github');
    expect(skill.inputSchema.required).toEqual(['issue_number']);
  });

  it('returns detail summary listing assignees when issue has them', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(issueResponse())) as unknown as typeof fetch;
    const skill = buildIssueAssigneesSkill(liveCtx(fetchImpl));
    const result = await skill.handler({ issue_number: 14 }, SKILL_CTX);
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
      Promise.resolve(issueResponse({ number: 7, title: 'Unassigned', assignees: [] })),
    ) as unknown as typeof fetch;
    const skill = buildIssueAssigneesSkill(liveCtx(fetchImpl));
    const result = await skill.handler({ issue_number: 7 }, SKILL_CTX);
    expect(result.summary).toContain('no current assignees');
    expect(result.items).toBeUndefined();
  });

  it('hits /repos/{owner}/{name}/issues/{number} with the org\'s first connected repo', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(issueResponse({ number: 99 }));
    }) as unknown as typeof fetch;
    const skill = buildIssueAssigneesSkill(liveCtx(fetchImpl, [{ owner: 'Nath5', name: 'risezome' }]));
    await skill.handler({ issue_number: 99 }, SKILL_CTX);
    expect(capturedUrl).toContain('/repos/Nath5/risezome/issues/99');
  });

  it('returns the connect-GitHub message when the org has no source', async () => {
    const skill = buildIssueAssigneesSkill(liveCtxNoSource());
    const result = await skill.handler({ issue_number: 14 }, SKILL_CTX);
    expect(result.summary).toContain('No GitHub repository is connected');
  });

  it('404 maps to SkillExecutionError code=not-found', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;
    const skill = buildIssueAssigneesSkill(liveCtx(fetchImpl));
    await expect(skill.handler({ issue_number: 999 }, SKILL_CTX)).rejects.toMatchObject({
      executionCode: 'not-found',
    });
  });

  it('rate-limit maps to SkillExecutionError code=rate-limit', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    ) as unknown as typeof fetch;
    const skill = buildIssueAssigneesSkill(liveCtx(fetchImpl));
    await expect(skill.handler({ issue_number: 14 }, SKILL_CTX)).rejects.toMatchObject({
      executionCode: 'rate-limit',
    });
  });

  it('handler throws SkillExecutionError instance (not plain Error)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 500 }))) as unknown as typeof fetch;
    const skill = buildIssueAssigneesSkill(liveCtx(fetchImpl));
    await expect(skill.handler({ issue_number: 14 }, SKILL_CTX)).rejects.toBeInstanceOf(SkillExecutionError);
  });
});
