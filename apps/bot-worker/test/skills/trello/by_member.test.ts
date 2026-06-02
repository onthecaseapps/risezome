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

  it('empty result (real member, no card in scope) → "not assigned to any" message', async () => {
    // Alice is a real member with cards, just none in the Done column — a
    // genuine empty (both args valid), so no recovery fires.
    const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler(
      { member: 'alice', list: 'Done' },
      SKILL_CTX,
    );
    expect(result.summary).toBe('alice is not assigned to any Trello cards.');
    expect(result.items).toBeUndefined();
    expect(result.recovery).toBeUndefined();
  });

  it('asks for a member when none is given', async () => {
    const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler({}, SKILL_CTX);
    expect(result.kind).toBe('detail');
    expect(result.summary).toContain('Specify which member');
  });

  describe('self-healing (U3)', () => {
    it('a bogus member → unresolved (the skill is about the member)', async () => {
      const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler(
        { member: 'Jraffe' },
        SKILL_CTX,
      );
      expect(result.recovery?.status).toBe('unresolved');
      expect(result.recovery?.neutralized).toEqual([{ arg: 'member', value: 'Jraffe' }]);
    });

    it('a bogus member is unresolved even when another scope survives (member is the point)', async () => {
      // board 'Roadmap' is valid and would survive as a scope, but a result
      // that isn't about the requested member is meaningless → unresolved.
      const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler(
        { member: 'Jraffe', board: 'Roadmap' },
        SKILL_CTX,
      );
      expect(result.recovery?.status).toBe('unresolved');
    });

    it('KTD9: a partial member name (substring of a real member) resolves normally', async () => {
      const result = await buildTrelloByMemberSkill(trelloCtx([ROADMAP])).handler(
        { member: 'Bob' },
        SKILL_CTX,
      );
      expect(result.recovery).toBeUndefined();
      expect(result.summary).toBe('Bob is assigned to 2 cards:');
    });
  });
});
