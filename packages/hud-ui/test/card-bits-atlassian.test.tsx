import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CardHeaderRow, sourceChipClass } from '../src/components/card-bits.js';
import type { CardEvent } from '../src/types.js';

function card(source: string, type: string, title: string): CardEvent {
  return {
    cardId: 'c1',
    docId: `${source}:1:1`,
    source,
    type,
    title,
    snippet: '',
    score: 0.9,
    rank: 2,
    url: 'https://example.atlassian.net/x',
  } as unknown as CardEvent;
}

describe('Atlassian source chips + type labels', () => {
  it('maps confluence to its branded chip and jira to its existing chip', () => {
    expect(sourceChipClass('confluence')).toBe('chip-source chip-source-confluence');
    expect(sourceChipClass('jira')).toBe('chip-source chip-source-jira');
  });

  it('renders a Jira issue with the jira chip and "Issue" label', () => {
    const { container, getByText } = render(<CardHeaderRow card={card('jira', 'issue', 'AUTH-1')} />);
    expect(container.querySelector('.chip-source-jira')).not.toBeNull();
    expect(getByText('jira')).toBeTruthy();
    expect(getByText('Issue')).toBeTruthy();
  });

  it('renders a Confluence page with the confluence chip and "Page" label', () => {
    const { container, getByText } = render(<CardHeaderRow card={card('confluence', 'page', 'Rollout')} />);
    expect(container.querySelector('.chip-source-confluence')).not.toBeNull();
    expect(getByText('confluence')).toBeTruthy();
    expect(getByText('Page')).toBeTruthy();
  });
});
