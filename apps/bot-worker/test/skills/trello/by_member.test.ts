import { describe, expect, it } from 'vitest';
import { buildTrelloByMemberSkill } from '../../../src/skills/trello/by_member.js';
import { SKILL_CTX, ROADMAP, trelloCtx } from './_ctx.js';

describe('trello_by_member (live API)', () => {
  it('requires a member name in the schema', () => {
    const skill = buildTrelloByMemberSkill(trelloCtx([ROADMAP]));
    expect(skill.name).toBe('trello_by_member');
    expect(skill.inputSchema.required).toEqual(['member']);
  });

  it('lists the cards a member is assigned to', async () => {
    const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler({ member: 'alice' }, SKILL_CTX);
    expect(result.kind).toBe('list');
    expect(result.summary).toBe('alice is assigned to 2 cards:');
    expect(result.items?.map((i) => i.title).sort()).toEqual(['Fix login', 'Write docs']);
  });

  it('can scope a member to a column', async () => {
    const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler(
      { member: 'alice', list: 'Backlog' },
      SKILL_CTX,
    );
    expect(result.summary).toBe('alice is assigned to 1 card:');
    expect(result.items?.[0]?.title).toBe('Write docs');
  });

  it('empty result → "not assigned to any" message', async () => {
    const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler({ member: 'zoe' }, SKILL_CTX);
    expect(result.summary).toBe('zoe is not assigned to any Trello cards.');
    expect(result.items).toBeUndefined();
  });

  it('asks for a member when none is given', async () => {
    const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler({}, SKILL_CTX);
    expect(result.kind).toBe('detail');
    expect(result.summary).toContain('Specify which member');
  });
});
