import { describe, expect, it } from 'vitest';
import {
  buildSearchCountSkill,
  buildSearchQualifiers,
} from '../../../src/skills/github/search_count.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import type { GithubAccess } from '../../../src/skills/github/source-resolver.js';
import { SKILL_CTX, liveCtxNoSource, jsonResponse } from './_live-ctx.js';

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

  it('strips double-quotes from label values (qualifier injection)', () => {
    expect(buildSearchQualifiers({ labels: ['bug" org:victim label:"x'] })).toBe(
      'label:"bug org:victim label:x"',
    );
    // A label that is nothing but quotes is dropped, not emitted empty.
    expect(buildSearchQualifiers({ labels: ['""'] })).toBe('');
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
  repoLabels: string[] = ['bug', 'phase-2', 'enhancement'],
): { ctx: LiveSkillContext; access: GithubAccess } {
  const access: GithubAccess = {
    installations: [
      { installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] },
    ],
  };
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    capture?.(url);
    // Self-heal validates labels via /repos/{owner}/{name}/labels.
    if (url.includes('/labels')) {
      return Promise.resolve(
        new Response(JSON.stringify(repoLabels.map((name) => ({ name }))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
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

describe('github_count self-healing (U2)', () => {
  it('AE1: a bogus label with a surviving scope → repaired (not 0)', async () => {
    // repo labels are [bug, enhancement]; "case" doesn't exist.
    const { ctx } = ctxReturning({ 'acme/widget': 12 }, undefined, ['bug', 'enhancement']);
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', labels: ['case'] },
      SKILL_CTX,
    );
    expect(result.recovery?.status).toBe('repaired');
    expect(result.recovery?.neutralized).toEqual([{ arg: 'labels', value: 'case' }]);
    expect(result.recovery?.note).toContain("'case'");
    // Count reflects the surviving type/state scope, not a misleading 0.
    expect(result.summary).toBe('12 open issues.');
  });

  it('KTD8: a bogus label that was the ONLY filter → unresolved (unscoped)', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 300 }, undefined, ['bug', 'enhancement']);
    const result = await buildSearchCountSkill(ctx).handler({ labels: ['case'] }, SKILL_CTX);
    expect(result.recovery?.status).toBe('unresolved');
  });

  it('AE2: a valid label → no recovery, plain count', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 2 }, undefined, ['bug', 'enhancement']);
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', labels: ['bug'] },
      SKILL_CTX,
    );
    expect(result.recovery).toBeUndefined();
    expect(result.summary).toBe("2 open issues labeled 'bug'.");
  });

  it('AE3/R7: a valid label that genuinely matches zero → count 0, no recovery', async () => {
    const { ctx } = ctxReturning({ 'acme/widget': 0 }, undefined, ['bug', 'enhancement']);
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', labels: ['bug'] },
      SKILL_CTX,
    );
    expect(result.recovery).toBeUndefined();
    expect(result.summary).toBe('No matching issues.');
  });

  it('KTD6: a label real in ANY connected repo is valid (union, not intersection)', async () => {
    // widget has [bug]; gadget has [frontend]. "frontend" is valid via union.
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
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/repos/acme/widget/labels')) {
        return Promise.resolve(jsonResponse([{ name: 'bug' }]));
      }
      if (url.includes('/repos/acme/gadget/labels')) {
        return Promise.resolve(jsonResponse([{ name: 'frontend' }]));
      }
      return Promise.resolve(jsonResponse({ total_count: 7 }));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      resolve: async () => access,
    };
    const result = await buildSearchCountSkill(ctx).handler(
      { state: 'open', labels: ['frontend'] },
      SKILL_CTX,
    );
    expect(result.recovery).toBeUndefined();
  });

  it('AE5: a bogus author with a surviving scope → author neutralized, repaired', async () => {
    const access: GithubAccess = {
      installations: [{ installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] }],
    };
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/frobnicate')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      if (url.includes('/search/users')) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      return Promise.resolve(jsonResponse({ total_count: 9 }));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      resolve: async () => access,
    };
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', author: 'frobnicate' },
      SKILL_CTX,
    );
    expect(result.recovery?.status).toBe('repaired');
    expect(result.recovery?.neutralized).toEqual([{ arg: 'author', value: 'frobnicate' }]);
    expect(result.summary).toBe('9 open issues.');
  });

  it('fetches /labels once per repo when a label arg is present (memoized within the call)', async () => {
    let labelFetches = 0;
    const { ctx } = ctxReturning({ 'acme/widget': 2 }, (url) => {
      if (url.includes('/labels')) labelFetches += 1;
    });
    await buildSearchCountSkill(ctx).handler({ labels: ['bug'] }, SKILL_CTX);
    expect(labelFetches).toBe(1);
  });

  it('a failed /labels fetch degrades to unresolved (RAG fallback), not a crash', async () => {
    const access: GithubAccess = {
      installations: [{ installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] }],
    };
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/labels')) {
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      return Promise.resolve(jsonResponse({ total_count: 5 }));
    });
    const ctx: LiveSkillContext = {
      client: new GithubClient({ fetchImpl }),
      resolve: async () => access,
    };
    const result = await buildSearchCountSkill(ctx).handler({ labels: ['bug'] }, SKILL_CTX);
    expect(result.recovery?.status).toBe('unresolved');
  });

  it('R2 common path: a safe-enum-only query issues NO /labels fetch and no recovery', async () => {
    let labelFetches = 0;
    const { ctx } = ctxReturning({ 'acme/widget': 3 }, (url) => {
      if (url.includes('/labels')) labelFetches += 1;
    });
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open' },
      SKILL_CTX,
    );
    expect(labelFetches).toBe(0);
    expect(result.recovery).toBeUndefined();
  });

  it('multi-label partial: a valid + a bogus label → bogus dropped, valid survives in the query, repaired', async () => {
    let seen = '';
    const { ctx } = ctxReturning({ 'acme/widget': 2 }, (url) => (seen = url), ['bug', 'enhancement']);
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', labels: ['bug', 'case'] },
      SKILL_CTX,
    );
    expect(result.recovery?.status).toBe('repaired');
    expect(result.recovery?.neutralized).toEqual([{ arg: 'labels', value: 'case' }]);
    // The surviving valid label is still in the Search query.
    expect(decodeURIComponent(seen).replace(/\+/g, ' ')).toContain('label:"bug"');
    expect(decodeURIComponent(seen).replace(/\+/g, ' ')).not.toContain('label:"case"');
  });

  it('author canonicalization: a resolvable author is rewritten to its real login, no recovery', async () => {
    let seen = '';
    const access: GithubAccess = {
      installations: [{ installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] }],
    };
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/users/Jamie')) return Promise.resolve(new Response('nf', { status: 404 }));
      if (url.includes('/search/users')) return Promise.resolve(jsonResponse({ items: [{ login: 'jamie-dev' }] }));
      seen = url;
      return Promise.resolve(jsonResponse({ total_count: 4 }));
    });
    const ctx: LiveSkillContext = { client: new GithubClient({ fetchImpl }), resolve: async () => access };
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', author: 'Jamie' },
      SKILL_CTX,
    );
    expect(result.recovery).toBeUndefined();
    expect(decodeURIComponent(seen).replace(/\+/g, ' ')).toContain('author:jamie-dev');
  });

  it('incomplete domain (label set truncated at the page cap) → an unmatched label is NOT neutralized', async () => {
    // Every /labels page returns a FULL page of 100 (none named 'wontfix'),
    // so the union never short-circuits → complete=false. A real-but-unseen
    // label must NOT be confidently dropped.
    const hundred = Array.from({ length: 100 }, (_v, i) => ({ name: `label-${String(i)}` }));
    const access: GithubAccess = {
      installations: [{ installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] }],
    };
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/labels')) return Promise.resolve(jsonResponse(hundred));
      return Promise.resolve(jsonResponse({ total_count: 3 }));
    });
    const ctx: LiveSkillContext = { client: new GithubClient({ fetchImpl }), resolve: async () => access };
    const result = await buildSearchCountSkill(ctx).handler(
      { type: 'issue', state: 'open', labels: ['wontfix'] },
      SKILL_CTX,
    );
    // Domain was incomplete → no confident neutralization.
    expect(result.recovery).toBeUndefined();
  });

  it('a 401 from the /labels fetch propagates as a skill failure (not a silent misparse)', async () => {
    const access: GithubAccess = {
      installations: [{ installationId: 1, token: 't1', repos: [{ owner: 'acme', name: 'widget' }] }],
    };
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/labels')) return Promise.resolve(new Response('no', { status: 401 }));
      return Promise.resolve(jsonResponse({ total_count: 1 }));
    });
    const ctx: LiveSkillContext = { client: new GithubClient({ fetchImpl }), resolve: async () => access };
    await expect(
      buildSearchCountSkill(ctx).handler({ type: 'issue', labels: ['bug'] }, SKILL_CTX),
    ).rejects.toMatchObject({ executionCode: 'auth-error' });
  });
});
