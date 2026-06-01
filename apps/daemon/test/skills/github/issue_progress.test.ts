import { describe, expect, it, vi } from 'vitest';
import { buildIssueProgressSkill } from '../../../src/skills/github/issue_progress.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { GithubClient } from '../../../src/connectors/github/client.js';
import type { AuthResult } from '../../../src/connectors/contract.js';

const AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };
const FAKE_CTX_FN = (): never => {
  throw new Error('signal should not be invoked in these tests');
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface MockResponses {
  issue: unknown;
  timeline: unknown;
}

function ctxWith(mocks: MockResponses): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/timeline')) {
      return Promise.resolve(jsonResponse(mocks.timeline));
    }
    return Promise.resolve(jsonResponse(mocks.issue));
  });
  return {
    client: new GithubClient({ fetchImpl }),
    auth: AUTH,
    repo: { owner: 'Nath5', name: 'risezome' },
  };
}

const BASE_ISSUE = {
  id: 1,
  number: 14,
  title: 'Auth refactor',
  state: 'open' as const,
  html_url: 'https://github.com/Nath5/risezome/issues/14',
  body: null,
  user: { login: 'jamie' },
  assignees: [{ login: 'Nath5' }],
  labels: [{ name: 'phase-2' }],
  created_at: '2026-05-20T12:00:00Z',
  updated_at: '2026-05-29T12:00:00Z',
};

describe('github_issue_progress', () => {
  it('returns skill with correct schema (issue_number, minimum: 1)', () => {
    const skill = buildIssueProgressSkill(ctxWith({ issue: BASE_ISSUE, timeline: [] }));
    expect(skill.name).toBe('github_issue_progress');
    const props = skill.inputSchema.properties;
    if (props.issue_number?.type === 'integer') {
      expect(props.issue_number.minimum).toBe(1);
    }
  });

  it('renders headline with state, assignees, and labels', async () => {
    const skill = buildIssueProgressSkill(ctxWith({ issue: BASE_ISSUE, timeline: [] }));
    const result = await skill.handler(
      { issue_number: 14 },
      { db: null as never, now: FAKE_CTX_FN },
    );
    expect(result.summary).toContain('#14');
    expect(result.summary).toContain('Auth refactor');
    expect(result.summary).toContain('open');
    expect(result.summary).toContain('Nath5');
    expect(result.summary).toContain('phase-2');
  });

  it('"No recent activity" when timeline is empty', async () => {
    const skill = buildIssueProgressSkill(ctxWith({ issue: BASE_ISSUE, timeline: [] }));
    const result = await skill.handler(
      { issue_number: 14 },
      { db: null as never, now: FAKE_CTX_FN },
    );
    expect(result.summary).toContain('No recent activity');
  });

  it('picks the 5 newest load-bearing events from a noisy timeline', async () => {
    const timeline = [
      // 8 load-bearing events at varying times
      { event: 'commented', actor: { login: 'alice' }, created_at: '2026-05-28T01:00:00Z' },
      { event: 'commented', actor: { login: 'bob' }, created_at: '2026-05-29T01:00:00Z' },
      { event: 'labeled', actor: { login: 'jamie' }, label: { name: 'bug' }, created_at: '2026-05-29T02:00:00Z' },
      { event: 'closed', actor: { login: 'jamie' }, created_at: '2026-05-29T03:00:00Z' },
      { event: 'reopened', actor: { login: 'alice' }, created_at: '2026-05-29T04:00:00Z' },
      { event: 'assigned', actor: { login: 'jamie' }, assignee: { login: 'Nath5' }, created_at: '2026-05-29T05:00:00Z' },
      { event: 'unassigned', actor: { login: 'jamie' }, assignee: { login: 'old' }, created_at: '2026-05-29T06:00:00Z' },
      { event: 'unlabeled', actor: { login: 'jamie' }, label: { name: 'wip' }, created_at: '2026-05-29T07:00:00Z' },
      // 3 noise events that should be excluded
      { event: 'referenced', actor: { login: 'x' }, created_at: '2026-05-29T08:00:00Z' },
      { event: 'mentioned', actor: { login: 'x' }, created_at: '2026-05-29T09:00:00Z' },
      { event: 'subscribed', actor: { login: 'x' }, created_at: '2026-05-29T10:00:00Z' },
    ];
    const skill = buildIssueProgressSkill(ctxWith({ issue: BASE_ISSUE, timeline }));
    const result = await skill.handler(
      { issue_number: 14 },
      { db: null as never, now: FAKE_CTX_FN },
    );
    expect(result.items).toHaveLength(5);
    // Newest first — the most recent load-bearing event was unlabeled at 07:00
    expect(result.items?.[0]?.title).toContain('removed label "wip"');
    expect(result.items?.[1]?.title).toContain('unassigned old');
    expect(result.items?.[2]?.title).toContain('assigned Nath5');
    expect(result.items?.[3]?.title).toContain('reopened');
    expect(result.items?.[4]?.title).toContain('closed');
    // Noise events not present
    const allTitles = result.items?.map((it) => it.title).join(' ');
    expect(allTitles).not.toContain('referenced');
    expect(allTitles).not.toContain('subscribed');
  });

  it('formats commented events with the body as subtitle (truncated)', async () => {
    const longBody = 'a'.repeat(300);
    const timeline = [
      {
        event: 'commented',
        actor: { login: 'bob' },
        created_at: '2026-05-29T01:00:00Z',
        body: longBody,
      },
    ];
    const skill = buildIssueProgressSkill(ctxWith({ issue: BASE_ISSUE, timeline }));
    const result = await skill.handler(
      { issue_number: 14 },
      { db: null as never, now: FAKE_CTX_FN },
    );
    expect(result.items?.[0]?.title).toContain('bob commented');
    expect(result.items?.[0]?.subtitle?.length).toBeLessThanOrEqual(200);
  });

  it('404 on the issue endpoint propagates as SkillExecutionError code=not-found', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(new Response('', { status: 404 })));
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      auth: AUTH,
      repo: { owner: 'o', name: 'r' },
    };
    const skill = buildIssueProgressSkill(ctx);
    await expect(
      skill.handler({ issue_number: 999 }, { db: null as never, now: FAKE_CTX_FN }),
    ).rejects.toMatchObject({ executionCode: 'not-found' });
  });

  it('issue.assignees may be undefined or empty — headline omits assignees clause', async () => {
    const issue = { ...BASE_ISSUE, assignees: [], labels: [] };
    const skill = buildIssueProgressSkill(ctxWith({ issue, timeline: [] }));
    const result = await skill.handler(
      { issue_number: 14 },
      { db: null as never, now: FAKE_CTX_FN },
    );
    expect(result.summary).not.toContain('assigned to');
    expect(result.summary).not.toContain('labeled');
  });

  // Suppress unused-var warning for vi (kept for symmetry with sibling tests).
  void vi;
});
