import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SourceCardExpanded } from '../src/components/source-card-expanded.js';
import type { CardEvent } from '../src/types.js';

function mkSource(over: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'card_1',
    docId: 'doc_1',
    source: 'github',
    type: 'issue',
    title: 'Test source',
    snippet: 'shortened preview',
    body: 'The setting is [package] and the edition = "2021" line below it.',
    score: 0.9,
    rank: 1,
    metadata: {},
    surfacedAt: 0,
    triggeredBy: 'window',
    traceId: 't',
    ...over,
  };
}

describe('SourceCardExpanded', () => {
  it('renders collapsed header only when open=false (no body, no highlight)', () => {
    const { container } = render(
      <SourceCardExpanded source={mkSource()} open={false} />,
    );
    expect(container.querySelector('.source-card-expanded')?.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('.title-link')?.textContent).toBe('Test source');
    expect(container.querySelector('.source-body')).toBeNull();
    expect(container.querySelector('mark.quote-highlight')).toBeNull();
  });

  it('renders body and is-open class when open=true', () => {
    const { container } = render(
      <SourceCardExpanded source={mkSource()} open={true} />,
    );
    const root = container.querySelector('.source-card-expanded')!;
    expect(root.getAttribute('data-open')).toBe('true');
    expect(root.classList.contains('is-open')).toBe(true);
    expect(container.querySelector('.source-body')?.textContent).toContain('edition = "2021"');
  });

  it('renders body without highlight when quote is undefined', () => {
    const { container } = render(
      <SourceCardExpanded source={mkSource()} open={true} />,
    );
    expect(container.querySelector('mark.quote-highlight')).toBeNull();
    expect(container.querySelector('.source-body')?.getAttribute('data-has-highlight')).toBe('false');
  });

  it('wraps the matching substring in <mark.quote-highlight> when quote hits raw indexOf', () => {
    const { container } = render(
      <SourceCardExpanded source={mkSource()} open={true} quotes={['edition = "2021"']} />,
    );
    const mark = container.querySelector('mark.quote-highlight');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('edition = "2021"');
    expect(container.querySelector('.source-body')?.getAttribute('data-has-highlight')).toBe('true');
  });

  it('highlights every matched quote when the card is expanded with multiple quotes', () => {
    const body = 'alpha then beta and finally gamma in the body.';
    const { container } = render(
      <SourceCardExpanded source={mkSource({ body })} open={true} quotes={['alpha', 'gamma']} />,
    );
    const marks = [...container.querySelectorAll('mark.quote-highlight')].map((m) => m.textContent);
    expect(marks).toEqual(['alpha', 'gamma']);
  });

  it('expands without highlight when the quote does not match (quiet failure per R8)', () => {
    const { container } = render(
      <SourceCardExpanded
        source={mkSource()}
        open={true}
        quotes={['this text does not exist anywhere in the body']}
      />,
    );
    expect(container.querySelector('mark.quote-highlight')).toBeNull();
    expect(container.querySelector('.source-body')?.textContent).toContain('edition = "2021"');
  });

  it('finds the quote via whitespace-normalized fallback when body has run-of-spaces', () => {
    const body = 'foo    bar    baz extra';
    const { container } = render(
      <SourceCardExpanded
        source={mkSource({ body })}
        open={true}
        quotes={['foo bar baz']}
      />,
    );
    const mark = container.querySelector('mark.quote-highlight');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('foo    bar    baz');
  });

  it('security: a quote containing <script> renders as literal text, not as DOM', () => {
    const body = 'safe text <script>alert(1)</script> more text';
    const { container } = render(
      <SourceCardExpanded
        source={mkSource({ body })}
        open={true}
        quotes={['<script>alert(1)</script>']}
      />,
    );
    // The <mark> should contain literal characters; React text-node
    // rendering escapes them — no actual <script> element appears in DOM.
    const mark = container.querySelector('mark.quote-highlight');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('<script>alert(1)</script>');
    // Critical: there is no nested <script> element inside the source body.
    expect(container.querySelector('.source-body script')).toBeNull();
  });

  it('security: a body containing event-handler-looking attributes renders as text', () => {
    const body = 'arbitrary corpus <img src=x onerror=alert(1)> trailing';
    const { container } = render(
      <SourceCardExpanded source={mkSource({ body })} open={true} />,
    );
    // No live <img> element from the body should land in the DOM.
    expect(container.querySelector('.source-body img')).toBeNull();
    expect(container.querySelector('.source-body')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('falls back to snippet when body is undefined (legacy card without backfill)', () => {
    const source: CardEvent = {
      ...mkSource(),
      snippet: 'just the preview',
    };
    // Manually remove body to simulate a pre-U7 row.
    const { body: _body, ...legacy } = source;
    void _body;
    const { container } = render(
      <SourceCardExpanded source={legacy as CardEvent} open={true} />,
    );
    expect(container.querySelector('.source-body')?.textContent).toBe('just the preview');
  });
});
