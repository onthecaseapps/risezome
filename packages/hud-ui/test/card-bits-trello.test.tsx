import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CardHeaderRow, sourceChipClass } from '../src/components/card-bits.js';
import type { CardEvent } from '../src/types.js';

describe('Trello source chip + type label', () => {
  it('maps the trello source to its branded chip class', () => {
    expect(sourceChipClass('trello')).toBe('chip-source chip-source-trello');
    expect(sourceChipClass('github')).toBe('chip-source chip-source-github');
    expect(sourceChipClass('mystery')).toBe('chip-source chip-source-default');
  });

  it('renders a Trello card with the trello chip and a "Card" type label', () => {
    const card = {
      cardId: 'c1',
      docId: 'trello:b1:c1',
      source: 'trello',
      type: 'card',
      title: 'Auth migration',
      snippet: '',
      score: 0.9,
      rank: 2,
      url: 'https://trello.com/c/c1',
    } as unknown as CardEvent;

    const { container, getByText } = render(<CardHeaderRow card={card} />);
    expect(container.querySelector('.chip-source-trello')).not.toBeNull();
    // getByText throws if the text is absent, so reaching truthy is the assertion.
    expect(getByText('trello')).toBeTruthy();
    expect(getByText('Card')).toBeTruthy();
  });
});
