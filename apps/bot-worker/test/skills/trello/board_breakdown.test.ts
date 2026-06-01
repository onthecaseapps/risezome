import { describe, expect, it } from 'vitest';
import { buildTrelloBoardBreakdownSkill } from '../../../src/skills/trello/board_breakdown.js';
import { SKILL_CTX, ROADMAP, trelloCtx } from './_ctx.js';

describe('trello_board_breakdown (live API)', () => {
  it('counts cards per active column, in board order, including empty columns', async () => {
    const result = await buildTrelloBoardBreakdownSkill(trelloCtx([ROADMAP])).handler({}, SKILL_CTX);
    expect(result.kind).toBe('list');
    // Backlog(c2,c3)=2, Doing(c1)=1, Done(c4)=1; archived "Old" column excluded.
    expect(result.summary).toBe('Roadmap: Backlog 2, Doing 1, Done 1 (4 cards).');
    expect(result.items).toEqual([
      { title: 'Backlog', subtitle: '2 cards' },
      { title: 'Doing', subtitle: '1 card' },
      { title: 'Done', subtitle: '1 card' },
    ]);
  });

  it('scopes to a board by name', async () => {
    const result = await buildTrelloBoardBreakdownSkill(trelloCtx([ROADMAP])).handler({ board: 'road' }, SKILL_CTX);
    expect(result.summary).toBe('Roadmap: Backlog 2, Doing 1, Done 1 (4 cards).');
  });

  it('reports when no connected board matches the name', async () => {
    const result = await buildTrelloBoardBreakdownSkill(trelloCtx([ROADMAP])).handler({ board: 'sprint' }, SKILL_CTX);
    expect(result.kind).toBe('detail');
    expect(result.summary).toContain('No connected Trello board matches');
  });
});
