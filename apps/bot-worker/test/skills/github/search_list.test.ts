import { describe, expect, it } from 'vitest';
import { buildSearchListSkill } from '../../../src/skills/github/search_list.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { liveCtxNoSource, jsonResponse, SKILL_CTX } from './_live-ctx.js';

function searchItem(num: number, title: string, state: 'open' | 'closed' = 'open'): unknown {
  return {
    number: num,
    title,
    state,
    html_url: `https://github.com/o/r/issues/${String(num)}`,
    updated_at: `2026-05-${String(10 + num).padStart(2, '0')}T00:00:00Z`,
    repository_url: 'https://api.github.com/repos/o/r',
  };
}

function itemsCtx(items: unknown[]): LiveSkillContext {
  const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/search/issues')) return Promise.resolve(jsonResponse({ items }));
    throw new Error(`unexpected url: ${url}`);
  });
  return {
    client: new GithubClient({ fetchImpl }),
    resolve: async () => ({ installations: [{ installationId: 1, token: 't', repos: [{ owner: 'o', name: 'r' }] }] }),
  };
}

describe('github_list (live Search API)', () => {
  it('lists matching items with "#num · state" subtitles', async () => {
    const skill = buildSearchListSkill(itemsCtx([searchItem(1, 'one'), searchItem(2, 'two')]));
    const result = await skill.handler({ state: 'open' }, SKILL_CTX);
    expect(result.kind).toBe('list');
    expect(result.items).toHaveLength(2);
    expect(result.items?.map((i) => i.subtitle)).toContain('#1 · open');
  });

  it('empty result → "No matching" summary, no items', async () => {
    const skill = buildSearchListSkill(itemsCtx([]));
    const result = await skill.handler({}, SKILL_CTX);
    expect(result.summary).toContain('No matching');
    expect(result.items).toBeUndefined();
  });

  it('truncation note when the result hits the limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => searchItem(i + 1, `t${String(i + 1)}`));
    const skill = buildSearchListSkill(itemsCtx(items));
    const result = await skill.handler({ limit: 10 }, SKILL_CTX);
    expect(result.summary).toContain('showing first 10');
  });

  it('no GitHub source connected → connect-on-Sources summary', async () => {
    const skill = buildSearchListSkill(liveCtxNoSource());
    const result = await skill.handler({}, SKILL_CTX);
    expect(result.summary).toContain('No GitHub repository is connected');
  });
});
