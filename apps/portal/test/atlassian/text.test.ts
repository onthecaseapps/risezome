import { describe, expect, it } from 'vitest';
import { adfToText, storageToText } from '../../app/_lib/atlassian-text';

describe('adfToText', () => {
  it('extracts text from nested paragraphs and headings in reading order', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Auth migration' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Swap cookies for ' },
            { type: 'text', text: 'OAuth2', marks: [{ type: 'strong' }] },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };
    const text = adfToText(doc);
    expect(text).toContain('Auth migration');
    expect(text).toContain('Swap cookies for OAuth2.');
    // Heading and paragraph are on separate lines.
    expect(text.indexOf('Auth migration')).toBeLessThan(text.indexOf('Swap cookies'));
  });

  it('extracts list items', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
          ],
        },
      ],
    };
    const text = adfToText(doc);
    expect(text).toContain('one');
    expect(text).toContain('two');
  });

  it('returns empty string for a null/absent description', () => {
    expect(adfToText(null)).toBe('');
    expect(adfToText(undefined)).toBe('');
    expect(adfToText('not adf')).toBe('');
  });

  it('emits text for mention, status, emoji, and inlineCard inline nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: 'u1', text: '@Jane Doe' } },
            { type: 'text', text: ' please review ' },
            { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { shortName: ':rocket:' } },
            { type: 'text', text: ' see ' },
            { type: 'inlineCard', attrs: { url: 'https://example.atlassian.net/browse/P-9' } },
          ],
        },
      ],
    };
    const text = adfToText(doc);
    expect(text).toContain('@Jane Doe');
    expect(text).toContain('IN PROGRESS');
    expect(text).toContain(':rocket:');
    expect(text).toContain('https://example.atlassian.net/browse/P-9');
  });
});

describe('storageToText', () => {
  it('strips XHTML tags to readable text', () => {
    const storage = '<h1>Rollout</h1><p>Staged: <strong>internal</strong>, then canary.</p>';
    const text = storageToText(storage);
    expect(text).toContain('Rollout');
    expect(text).toContain('Staged: internal, then canary.');
    expect(text).not.toContain('<');
  });

  it('decodes basic entities and converts breaks to newlines', () => {
    const text = storageToText('<p>A &amp; B</p><p>line<br/>break</p>');
    expect(text).toContain('A & B');
    expect(text).toContain('line\nbreak');
  });

  it('decodes &amp; LAST so escaped entities are not double-decoded', () => {
    // A doc that literally shows "&lt;" is stored as "&amp;lt;" — it must
    // decode to "&lt;", not all the way to "<".
    expect(storageToText('<p>&amp;lt;tag&amp;gt;</p>')).toBe('&lt;tag&gt;');
  });

  it('decodes numeric character references (decimal and hex)', () => {
    expect(storageToText('<p>it&#39;s a &#x27;quote&#x27;</p>')).toBe("it's a 'quote'");
  });

  it('returns empty string for non-string input', () => {
    expect(storageToText(null)).toBe('');
    expect(storageToText(undefined)).toBe('');
  });
});
