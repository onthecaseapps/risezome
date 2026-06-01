import { describe, expect, it } from 'vitest';
import { buildTrelloListSkill } from '../../../src/skills/trello/list.js';
import { SKILL_CTX, ROADMAP, trelloCtx } from './_ctx.js';

describe('trello_list (live API)', () => {
  it('lists matching cards with "Board › Column · Members" subtitles + url', async () => {
    const result = await buildTrelloListSkill(trelloCtx([ROADMAP])).handler({ list: 'Backlog' }, SKILL_CTX);
    expect(result.kind).toBe('list');
    expect(result.summary).toBe('2 matching cards in Backlog:');
    expect(result.items).toHaveLength(2);
    const addExport = result.items?.find((i) => i.title === 'Add export');
    expect(addExport?.subtitle).toBe('Roadmap › Backlog · Bob Lee');
    expect(addExport?.url).toBe('https://trello.com/c/c2');
  });

  it('empty match → "No matching Trello cards" with the filter described, no items', async () => {
    const result = await buildTrelloListSkill(trelloCtx([ROADMAP])).handler({ label: 'nonexistent' }, SKILL_CTX);
    expect(result.summary).toBe('No matching Trello cards labeled nonexistent.');
    expect(result.items).toBeUndefined();
  });

  it('caps the item list at the limit but reports the true total', async () => {
    const result = await buildTrelloListSkill(trelloCtx([ROADMAP])).handler({ limit: 2 }, SKILL_CTX);
    expect(result.summary).toBe('4 matching cards (showing first 2 of 4):');
    expect(result.items).toHaveLength(2);
  });
});
