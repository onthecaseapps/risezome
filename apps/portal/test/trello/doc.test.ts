import { describe, expect, it } from 'vitest';
import { buildCardDocText, trelloCardDocId } from '../../app/_lib/trello-doc';
import type { TrelloCard, TrelloComment } from '../../app/_lib/trello-client';

function card(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: 'c1',
    name: 'Auth migration',
    desc: 'Swap session cookies for OAuth2.',
    listId: 'L',
    listName: 'Doing',
    url: 'https://trello.com/c/c1',
    dateLastActivity: null,
    ...overrides,
  };
}

const comment = (text: string, author: string | null): TrelloComment => ({
  id: `a-${text}`,
  text,
  author,
  date: null,
});

describe('trelloCardDocId', () => {
  it('uses the immutable board + card ids', () => {
    expect(trelloCardDocId('b1', 'c1')).toBe('trello:b1:c1');
  });
});

describe('buildCardDocText', () => {
  it('combines name, description, and authored comments', () => {
    const text = buildCardDocText(card(), [comment('blocked on review', 'Priya'), comment('lgtm', 'marco')]);
    expect(text).toContain('Auth migration');
    expect(text).toContain('Swap session cookies for OAuth2.');
    expect(text).toContain('Priya: blocked on review');
    expect(text).toContain('marco: lgtm');
  });

  it('omits an empty description and the comments section when there are none', () => {
    const text = buildCardDocText(card({ desc: '   ' }), []);
    expect(text).toBe('Auth migration');
    expect(text).not.toContain('Comments:');
  });

  it('skips blank comment bodies and defaults a missing author', () => {
    const text = buildCardDocText(card({ desc: '' }), [comment('   ', 'X'), comment('real note', null)]);
    expect(text).toContain('Unknown: real note');
    expect(text).not.toContain('X:');
  });
});
