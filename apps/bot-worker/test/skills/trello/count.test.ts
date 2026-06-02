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

describe('trello_count self-healing (U3)', () => {
  it('AE1: a bogus member with a surviving scope → repaired (not 0)', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler(
      { list: 'Backlog', member: 'Jraffe' },
      SKILL_CTX,
    );
    expect(result.recovery?.status).toBe('repaired');
    expect(result.recovery?.neutralized).toEqual([{ arg: 'member', value: 'Jraffe' }]);
    expect(result.recovery?.note).toContain('Jraffe');
    // Counts the surviving Backlog scope (2 cards), not a misleading 0.
    expect(result.summary).toBe('2 cards in Backlog.');
  });

  it('KTD8: a bogus member that was the ONLY filter → unresolved (unscoped)', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler(
      { member: 'Jraffe' },
      SKILL_CTX,
    );
    expect(result.recovery?.status).toBe('unresolved');
  });

  it('KTD9: a partial member name (substring of a real member) is NOT neutralized', async () => {
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler(
      { member: 'Alice' },
      SKILL_CTX,
    );
    expect(result.recovery).toBeUndefined();
    expect(result.summary).toBe('2 cards assigned to Alice.');
  });

  it('board re-fetch: a bogus board is neutralized BEFORE collect, so other args validate against a non-empty universe', async () => {
    // If board were validated after collectCards, the bogus board would yield
    // an empty universe and "alice" would also be (wrongly) neutralized →
    // unresolved. The fix widens to all boards first → member stays valid →
    // repaired.
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler(
      { board: 'Jraffe', member: 'alice' },
      SKILL_CTX,
    );
    expect(result.recovery?.status).toBe('repaired');
    expect(result.recovery?.neutralized).toEqual([{ arg: 'board', value: 'Jraffe' }]);
    expect(result.summary).toBe('2 cards assigned to alice.');
  });

  it('a valid label that genuinely matches zero → count 0, no recovery (genuine zero)', async () => {
    // "feature" is real; scoped to Doing (which has only a bug card) → 0.
    const result = await buildTrelloCountSkill(trelloCtx([ROADMAP])).handler(
      { list: 'Doing', label: 'feature' },
      SKILL_CTX,
    );
    expect(result.recovery).toBeUndefined();
    expect(result.summary).toBe('0 cards in Doing labeled feature.');
  });
});
