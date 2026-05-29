import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../../src/connectors/github/chunk-md.js';

describe('chunkMarkdown', () => {
  it('returns empty array for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n   ')).toEqual([]);
  });

  it('returns a single chunk for short content with no H2', () => {
    const md = '# Title\n\nSome introductory prose that is long enough to count.';
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.text).toContain('# Title');
  });

  it('splits on H2 headings', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph that is more than the eighty character minimum length to count as a chunk.',
      '',
      '## First section',
      '',
      'First section body that also exceeds the eighty character minimum.',
      '',
      '## Second section',
      '',
      'Second section body that also exceeds the eighty character minimum.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[1]?.heading).toBe('First section');
    expect(chunks[2]?.heading).toBe('Second section');
  });

  it('falls back to fixed-window splitting for huge sections', () => {
    const giant = 'foo bar baz '.repeat(500);
    const md = `## Giant\n\n${giant}`;
    const chunks = chunkMarkdown(md, { maxChunkChars: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => {
      expect(c.text.length).toBeLessThanOrEqual(800);
      expect(c.heading).toBe('Giant');
    });
  });

  it('treats H3+ as splits too (any deeper heading is a section boundary)', () => {
    const md = [
      '## Top',
      '',
      'Top body that is meaningfully long for our chunk floor.',
      '',
      '### Subsection',
      '',
      'Sub body that is also meaningfully long for our chunk floor.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.heading)).toEqual(['Top', 'Subsection']);
  });

  it('does NOT include the heading line in the chunk body (downstream re-adds it)', () => {
    // Regression: previously the chunker kept the `## Heading` line at the
    // start of `body`, and `pull-files.ts` prepended `## ${heading}` on top,
    // producing chunks where the heading appeared TWICE.
    const md = [
      '## Outstanding Questions',
      '',
      'Question one body that meets the minimum body length floor.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe('Outstanding Questions');
    expect(chunks[0]?.text).not.toContain('## Outstanding Questions');
    expect(chunks[0]?.text).toContain('Question one body');
  });

  it('drops sections whose body is empty after stripping the heading line', () => {
    // A template stub like `## Outstanding Questions\n\n## Next Section`
    // used to embed as a chunk containing just the heading line — a
    // degenerate vector. After the fix it disappears.
    const md = [
      '## Outstanding Questions',
      '',
      '## Next Section',
      '',
      'Real body content that exceeds the minimum length floor easily.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.heading)).toEqual(['Next Section']);
  });
});
