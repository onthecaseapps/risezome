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

  it('returns empty string for non-string input', () => {
    expect(storageToText(null)).toBe('');
    expect(storageToText(undefined)).toBe('');
  });
});
