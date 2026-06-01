import { describe, expect, it } from 'vitest';
import {
  buildSearchCountSkill,
  buildSearchQualifiers,
} from '../../../src/skills/github/search_count.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import type { GithubAccess } from '../../../src/skills/github/source-resolver.js';
import { SKILL_CTX, liveCtxNoSource } from './_live-ctx.js';

describe('buildSearchQualifiers', () => {
  it('empty filter → empty qualifiers (repo: is prepended by the caller)', () => {
    expect(buildSearchQualifiers({})).toBe('');
  });

  it('maps type=issue to type:issue', () => {
    expect(buildSearchQualifiers({ type: 'issue' })).toBe('type:issue');
  });

  it('maps type=pull-request to type:pr (GitHub search vocabulary)', () => {
    expect(buildSearchQualifiers({ type: 'pull-request' })).toBe('type:pr');
  });

  it('adds state qualifier', () => {
    expect(buildSearchQualifiers({ type: 'issue', state: 'open' })).toBe('type:issue state:open');
  });

  it('quotes labels so multi-word labels match', () => {
    expect(buildSearchQualifiers({ labels: ['good first issue', 'bug'] })).toBe(
      'label:"good first issue" label:"bug"',
    );
  });

  it('adds author qualifier', () => {
    expect(buildSearchQualifiers({ author: 'jamie' })).toBe('author:jamie');
  });

  it('composes all qualifiers in order', () => {
    expect(
      buildSearchQualifiers({ type: 'issue', state: 'open', labels: ['bug'], author: 'jamie' }),
    ).toBe('type:issue state:open label:"bug" author:jamie');
  });
});

function ctxReturning(
  totalByRepo: Record<string, number>,
  capture?: (url: string) => void,
): { ctx: LiveSkillContext; access: GithubAccess } {
  const access: GithubAccess = {
    installations: [
      { installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] },
    ],
  };
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    capture?.(url);
    // Sum any total counts whose repo qualifier appears in the query.
    const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
    let total = 0;
    for (const [repo, n] of Object.entries(totalByRepo)) {
      if (decoded.includes(`repo:${repo}`)) total += n;
    }
    return Promise.resolve(
      new Response(JSON.stringify({ total_count: total }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { ctx: { client: new GithubClient({ fetchImpl }), resolve: async () => access }, access };
}

describe('github_count (live Search API)', () => {
  it('registers as github_count', () => {
    expect(buildSearchCountSkill(ctxReturning({}).ctx).name).toBe('github_count');
  });

  it('returns the daemon-verbatim summary wording (shared with corpus count)', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 5 });
    const result = await buildSearchCountSkill(ctx).handler({ type: 'issue', state: 'open' }, SKILL_CTX);
    expect(result.kind).toBe('count');
    expect(result.summary).toBe('5 open issues.');
  });

  it('zero total_count → "No matching issues."', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 0 });
    const result = await buildSearchCountSkill(ctx).handler({ type: 'issue', state: 'open' }, SKILL_CTX);
    expect(result.summary).toBe('No matching issues.');
  });

  it('singular noun at count 1', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 1 });
    const result = await buildSearchCountSkill(ctx).handler({ type: 'issue', state: 'open' }, SKILL_CTX);
    expect(result.summary).toBe('1 open issue.');
  });

  it('labels render in the summary identically to the corpus skill', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 2 });
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', labels: ['bug', 'phase-2'] },
      SKILL_CTX,
    );
    expect(result.summary).toBe("2 open issues labeled 'bug' and 'phase-2'.");
  });

  it('hits /search/issues with the repo-scoped query + per_page=1', async () => {
    let seen = '';
    const { ctx } = ctxReturning({ 'acme/widget': 3 }, (url) => (seen = url));
    await buildSearchCountSkill(ctx).handler({ type: 'issue', state: 'open' }, SKILL_CTX);
    expect(seen).toContain('/search/issues');
    expect(seen).toContain('per_page=1');
    const decoded = decodeURIComponent(seen).replace(/\+/g, ' ');
    expect(decoded).toContain('repo:acme/widget type:issue state:open');
  });

  it('counts across multiple repos (sums total_count per installation)', async () => {
    const access: GithubAccess = {
      installations: [
        {
          installationId: 1,
          token: 't1',
          repos: [
            { owner: 'acme', name: 'widget' },
            { owner: 'acme', name: 'gadget' },
          ],
        },
      ],
    };
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ total_count: 4 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ));
    const ctx: LiveSkillContext = { client: new GithubClient({ fetchImpl }), resolve: async () => access };
    // One installation → one query covering both repos → total_count = 4.
    const result = await buildSearchCountSkill(ctx).handler({ type: 'issue', state: 'open' }, SKILL_CTX);
    expect(result.summary).toBe('4 open issues.');
  });

  it('no GitHub source → connect-GitHub message', async () => {
    const result = await buildSearchCountSkill(liveCtxNoSource()).handler(
      { type: 'issue', state: 'open' },
      SKILL_CTX,
    );
    expect(result.summary).toContain('No GitHub repository is connected');
  });
});
