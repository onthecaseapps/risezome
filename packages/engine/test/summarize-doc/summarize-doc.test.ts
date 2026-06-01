import { describe, expect, it, vi } from 'vitest';
import { summarizeDoc, type DocSummarizer } from '../../src/summarize-doc/summarize-doc.js';

describe('summarizeDoc', () => {
  it('returns the trimmed summary', async () => {
    const s: DocSummarizer = vi.fn(async () => '  The project uses Claude Haiku, Voyage, Deepgram.  ');
    expect(await summarizeDoc('full doc', 'README', s)).toBe('The project uses Claude Haiku, Voyage, Deepgram.');
  });

  it('skips empty documents without calling the summarizer', async () => {
    const s = vi.fn(async () => 'x');
    expect(await summarizeDoc('   ', 't', s)).toBe('');
    expect(s).not.toHaveBeenCalled();
  });

  it('falls back to empty on summarizer failure (body chunks still index)', async () => {
    const s: DocSummarizer = async () => {
      throw new Error('llm 500');
    };
    expect(await summarizeDoc('doc', 't', s)).toBe('');
  });

  it('passes the full document and title through', async () => {
    const s = vi.fn(async () => 'sum');
    await summarizeDoc('THE DOC', 'Title', s);
    expect(s).toHaveBeenCalledWith('THE DOC', 'Title');
  });
});
