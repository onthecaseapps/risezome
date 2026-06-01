import { describe, expect, it } from 'vitest';
import { buildTrelloCountSkill } from '../../../src/skills/trello/count.js';
import { SKILL_CTX, ROADMAP, trelloCtx, trelloCtxNoSource } from './_ctx.js';

describe('trello_count (live API)', () => {
  it('registers as trello_count from the trello source', () => {
    const skill = buildTrelloCountSkill(trelloCtx([ROADMAP]));
    expect(skill.name).toBe('trello_count');
    expect(skill.source).toBe('trello');
  });

  it('counts active cards across the board (archived-list + closed cards excluded)', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler({}, SKILL_CTX);
    expect(result.kind).toBe('count');
    expect(result.summary).toBe('4 cards.');
  });

  it('scopes by list/column', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler({ list: 'Doing' }, SKILL_CTX);
    expect(result.summary).toBe('1 card in Doing.');
  });

  it('scopes by member (case-insensitive substring of the display name)', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler({ member: 'alice' }, SKILL_CTX);
    expect(result.summary).toBe('2 cards assigned to alice.');
  });

  it('scopes by label', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler({ label: 'bug' }, SKILL_CTX);
    expect(result.summary).toBe('2 cards labeled bug.');
  });

  it('filters due:overdue (past due, not complete) against the fixed now', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler({ due: 'overdue' }, SKILL_CTX);
    expect(result.summary).toBe('1 card overdue.');
  });

  it('filters due:none', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler({ due: 'none' }, SKILL_CTX);
    expect(result.summary).toBe('1 card with no due date.');
  });

  it('returns the connect-Trello message when the org has no board', async () => {
    const result = await buildTrelloCountSkill(trelloCtxNoSource()).handler({}, SKILL_CTX);
    expect(result.kind).toBe('detail');
    expect(result.summary).toContain('Connect a board on the Sources page');
  });
});
