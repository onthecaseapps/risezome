import { describe, expect, it } from 'vitest';
import { buildTrelloRecentlyActiveSkill } from '../../../src/skills/trello/recently_active.js';
import { SKILL_CTX, ROADMAP, trelloCtx } from './_ctx.js';

describe('trello_recently_active (live API)', () => {
  it('orders active cards newest-first by last activity', async () => {
    const result = await buildTrelloRecentlyActiveSkill(trelloCtx([ROADMAP])).handler({}, SKILL_CTX);
    expect(result.kind).toBe('list');
    expect(result.summary).toBe('4 recently active cards:');
    expect(result.items?.map((i) => i.title)).toEqual(['Fix login', 'Write docs', 'Add export', 'Ship v1']);
  });

  it('surfaces the activity date in the subtitle', async () => {
    const result = await buildTrelloRecentlyActiveSkill(trelloCtx([ROADMAP])).handler({}, SKILL_CTX);
    expect(result.items?.[0]?.subtitle).toBe('Roadmap › Doing · Alice Smith · active 2026-05-30');
  });

  it('honors the limit and reports the true total', async () => {
    const result = await buildTrelloRecentlyActiveSkill(trelloCtx([ROADMAP])).handler({ limit: 2 }, SKILL_CTX);
    expect(result.summary).toBe('4 recently active cards (showing 2 most recent of 4):');
    expect(result.items?.map((i) => i.title)).toEqual(['Fix login', 'Write docs']);
  });
});
