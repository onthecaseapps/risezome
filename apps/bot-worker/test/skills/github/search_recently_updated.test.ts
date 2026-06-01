import { describe, expect, it } from 'vitest';
import { buildSearchRecentlyUpdatedSkill } from '../../../src/skills/github/search_recently_updated.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { liveCtxNoSource, jsonResponse, SKILL_CTX } from './_live-ctx.js';

function searchItem(num: number, title: string): unknown {
  return {
    number: num,
    title,
    state: 'open',
    html_url: `https://github.com/o/r/issues/${String(num)}`,
    updated_at: `2026-05-${String(10 + num).padStart(2, '0')}T00:00:00Z`,
    repository_url: 'https://api.github.com/repos/o/r',
  };
}

function capturingCtx(items: unknown[], onQuery: (q: string) => void): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/search/issues')) {
      onQuery(new URL(url).searchParams.get('q') ?? '');
      return Promise.resolve(jsonResponse({ items }));
    }
    throw new Error(`unexpected url: ${url}`);
  });
  return {
    client: new GithubClient({ fetchImpl }),
    resolve: async () => ({ installations: [{ installationId: 1, token: 't', repos: [{ owner: 'o', name: 'r' }] }] }),
  };
}

describe('github_recently_updated (live Search API)', () => {
  it('builds an updated:>= qualifier and lists with "updated <date>" subtitles', async () => {
    let q = '';
    const skill = buildSearchRecentlyUpdatedSkill(capturingCtx([searchItem(1, 'one')], (s) => (q = s)));
    const result = await skill.handler({ days: 7 }, SKILL_CTX);
    expect(q).toContain('updated:>=');
    expect(result.kind).toBe('list');
    expect(result.items?.[0]?.subtitle).toMatch(/^updated /);
    expect(result.summary).toContain('last 7 days');
  });

  it('adds a type qualifier when type is given', async () => {
    let q = '';
    const skill = buildSearchRecentlyUpdatedSkill(capturingCtx([], (s) => (q = s)));
    await skill.handler({ type: 'pull-request' }, SKILL_CTX);
    expect(q).toContain('type:pr');
  });

  it('empty result → "No issues or pull requests updated" summary', async () => {
    const skill = buildSearchRecentlyUpdatedSkill(capturingCtx([], () => undefined));
    const result = await skill.handler({ days: 3 }, SKILL_CTX);
    expect(result.summary).toContain('No issues or pull requests updated in the last 3 days');
  });

  it('no GitHub source connected → connect-on-Sources summary', async () => {
    const skill = buildSearchRecentlyUpdatedSkill(liveCtxNoSource());
    const result = await skill.handler({}, SKILL_CTX);
    expect(result.summary).toContain('No GitHub repository is connected');
  });
});
