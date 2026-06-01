import { describe, expect, it } from 'vitest';
import { buildSearchCountSkill, buildSearchQuery } from '../../../src/skills/github/search_count.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { AuthResult } from '../../../src/skills/github/connector-errors.js';

const AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };
const REPO = { owner: 'acme', name: 'widget' };
const FAKE_NOW = (): never => {
  throw new Error('not invoked');
};

describe('buildSearchQuery', () => {
  it('always scopes to the repo', () => {
    expect(buildSearchQuery(REPO, {})).toBe('repo:acme/widget');
  });

  it('maps type=issue to type:issue', () => {
    expect(buildSearchQuery(REPO, { type: 'issue' })).toBe('repo:acme/widget type:issue');
  });

  it('maps type=pull-request to type:pr (GitHub search vocabulary)', () => {
    expect(buildSearchQuery(REPO, { type: 'pull-request' })).toBe('repo:acme/widget type:pr');
  });

  it('adds state qualifier', () => {
    expect(buildSearchQuery(REPO, { type: 'issue', state: 'open' })).toBe(
      'repo:acme/widget type:issue state:open',
    );
  });

  it('quotes labels so multi-word labels match', () => {
    expect(buildSearchQuery(REPO, { labels: ['good first issue', 'bug'] })).toBe(
      'repo:acme/widget label:"good first issue" label:"bug"',
    );
  });

  it('adds author qualifier', () => {
    expect(buildSearchQuery(REPO, { author: 'jamie' })).toBe('repo:acme/widget author:jamie');
  });

  it('composes all qualifiers in order', () => {
    expect(
      buildSearchQuery(REPO, { type: 'issue', state: 'open', labels: ['bug'], author: 'jamie' }),
    ).toBe('repo:acme/widget type:issue state:open label:"bug" author:jamie');
  });
});

function ctxReturning(totalCount: number, capture?: (url: string) => void): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    capture?.(url);
    return Promise.resolve(
      new Response(JSON.stringify({ total_count: totalCount }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { client: new GithubClient({ fetchImpl }), auth: AUTH, repo: REPO };
}

describe('github_count (live Search API)', () => {
  it('registers as github_count', () => {
    expect(buildSearchCountSkill(ctxReturning(0)).name).toBe('github_count');
  });

  it('returns the daemon-verbatim summary wording (shared with corpus count)', async () => {
    const skill = buildSearchCountSkill(ctxReturning(5));
    const result = await skill.handler({ type: 'issue', state: 'open' }, { db: null as never, orgId: 'o', now: FAKE_NOW });
    expect(result.kind).toBe('count');
    expect(result.summary).toBe('5 open issues.');
  });

  it('zero total_count → "No matching issues."', async () => {
    const skill = buildSearchCountSkill(ctxReturning(0));
    const result = await skill.handler({ type: 'issue', state: 'open' }, { db: null as never, orgId: 'o', now: FAKE_NOW });
    expect(result.summary).toBe('No matching issues.');
  });

  it('singular noun at count 1', async () => {
    const skill = buildSearchCountSkill(ctxReturning(1));
    const result = await skill.handler({ type: 'issue', state: 'open' }, { db: null as never, orgId: 'o', now: FAKE_NOW });
    expect(result.summary).toBe('1 open issue.');
  });

  it('labels render in the summary identically to the corpus skill', async () => {
    const skill = buildSearchCountSkill(ctxReturning(2));
    const result = await skill.handler(
      { type: 'issue', state: 'open', labels: ['bug', 'phase-2'] },
      { db: null as never, orgId: 'o', now: FAKE_NOW },
    );
    expect(result.summary).toBe("2 open issues labeled 'bug' and 'phase-2'.");
  });

  it('hits /search/issues with q + per_page=1', async () => {
    let seen = '';
    const skill = buildSearchCountSkill(ctxReturning(3, (url) => (seen = url)));
    await skill.handler({ type: 'issue', state: 'open' }, { db: null as never, orgId: 'o', now: FAKE_NOW });
    expect(seen).toContain('/search/issues');
    expect(seen).toContain('per_page=1');
    // q is URL-encoded; URLSearchParams renders spaces as '+'. Decode
    // and normalize '+' back to space before asserting on the query.
    const decoded = decodeURIComponent(seen).replace(/\+/g, ' ');
    expect(decoded).toContain('repo:acme/widget type:issue state:open');
  });
});
