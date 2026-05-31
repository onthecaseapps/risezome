import { describe, expect, it } from 'vitest';
import {
  buildSystemPrefix,
  buildUserMessage,
  citationsToRanks,
  HAIKU_CACHE_MIN_CHAR_PROXY,
  parseSynthesisOutput,
  REFUSAL_SENTINEL,
} from '../../src/synthesize/prompt.js';
import type { SynthesisSource } from '../../src/synthesize/contract.js';

const SAMPLE_SOURCES: readonly SynthesisSource[] = [
  { rank: 1, title: 'Issue #6 — Per-meeting summary view', text: 'Status: planned (Phase 3).' },
  { rank: 2, title: 'plan.md §Phase 3', text: 'Summary view combines pinned cards + gap list + transcript link.' },
  { rank: 3, title: 'meeting/lifecycle.ts', text: 'Stub file (not yet implemented).' },
];

describe('buildUserMessage', () => {
  it('formats utterance + numbered sources into the exact expected layout', () => {
    const out = buildUserMessage('post meeting summary view', SAMPLE_SOURCES);
    expect(out).toBe(
      'Utterance: post meeting summary view\n\nSources:\n' +
        '[1] Issue #6 — Per-meeting summary view\nStatus: planned (Phase 3).\n\n' +
        '[2] plan.md §Phase 3\nSummary view combines pinned cards + gap list + transcript link.\n\n' +
        '[3] meeting/lifecycle.ts\nStub file (not yet implemented).',
    );
  });

  it('handles a single source cleanly (no trailing separator)', () => {
    const out = buildUserMessage('what about jira', [SAMPLE_SOURCES[0]!]);
    expect(out).toBe(
      'Utterance: what about jira\n\nSources:\n' +
        '[1] Issue #6 — Per-meeting summary view\nStatus: planned (Phase 3).',
    );
  });
});

describe('parseSynthesisOutput — new [N: "quote"] format', () => {
  it('extracts quoted citations with rank, position, and quote', () => {
    const text = 'This uses X [1: "line one"] and Y [2: "line two"].';
    const out = parseSynthesisOutput(text, 3);
    expect(out.isRefusal).toBe(false);
    expect(out.text).toBe(text);
    expect(out.citations).toEqual([
      { rank: 1, position: text.indexOf('[1:'), quote: 'line one' },
      { rank: 2, position: text.indexOf('[2:'), quote: 'line two' },
    ]);
  });

  it('preserves per-occurrence: same source cited twice yields two entries with their own quotes', () => {
    const text = 'A [1: "first quote"] and B [1: "second quote"].';
    const out = parseSynthesisOutput(text, 2);
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0]).toMatchObject({ rank: 1, quote: 'first quote' });
    expect(out.citations[1]).toMatchObject({ rank: 1, quote: 'second quote' });
  });

  it('unescapes \\" inside the quote payload', () => {
    const text = 'The setting is [1: "the \\"name\\" field"].';
    const out = parseSynthesisOutput(text, 1);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]!.quote).toBe('the "name" field');
  });

  it('unescapes \\\\ inside the quote payload', () => {
    const text = 'Regex is [1: "\\\\d+"].';
    const out = parseSynthesisOutput(text, 1);
    expect(out.citations[0]!.quote).toBe('\\d+');
  });

  it('accepts empty quote and preserves it', () => {
    const text = 'Citation with no quote [1: ""].';
    const out = parseSynthesisOutput(text, 1);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]!.quote).toBe('');
  });

  it('accepts back-to-back citations without separator: [1: "a"][2: "b"]', () => {
    const text = 'Two sources at once [1: "first"][2: "second"].';
    const out = parseSynthesisOutput(text, 2);
    expect(out.citations.map((c) => c.rank)).toEqual([1, 2]);
    expect(out.citations.map((c) => c.quote)).toEqual(['first', 'second']);
  });

  it('drops out-of-range citations regardless of format', () => {
    const text = 'Per [5: "missing"] the planning is in progress.';
    const out = parseSynthesisOutput(text, 3);
    expect(out.citations).toEqual([]);
  });
});

describe('parseSynthesisOutput — backward-compat with bare [N]', () => {
  it('parses bare [N] with quote: undefined (Claude misformat fallback)', () => {
    const text = 'The view is planned [1] but not built [2].';
    const out = parseSynthesisOutput(text, 3);
    expect(out.citations).toEqual([
      { rank: 1, position: text.indexOf('[1]'), quote: undefined },
      { rank: 2, position: text.indexOf('[2]'), quote: undefined },
    ]);
  });

  it('mixes bare [N] and [N: "..."] in one answer', () => {
    const text = 'Quoted [1: "verbatim"] and bare [2].';
    const out = parseSynthesisOutput(text, 2);
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0]).toMatchObject({ rank: 1, quote: 'verbatim' });
    expect(out.citations[1]).toMatchObject({ rank: 2, quote: undefined });
  });

  it('returns empty citations when the answer has none', () => {
    const out = parseSynthesisOutput('Just text.', 3);
    expect(out.citations).toEqual([]);
    expect(out.isRefusal).toBe(false);
  });

  it('drops out-of-range citation [5] when only 3 sources were provided', () => {
    const out = parseSynthesisOutput('Per [5] the planning is in progress.', 3);
    expect(out.citations).toEqual([]);
    expect(out.isRefusal).toBe(false);
  });

  it('drops a mix of valid and invalid citation numbers', () => {
    const out = parseSynthesisOutput('A [1], B [99], C [2], D [0].', 2);
    expect(out.citations.map((c) => c.rank)).toEqual([1, 2]);
  });
});

describe('parseSynthesisOutput — refusal', () => {
  it('detects the exact-match refusal sentinel', () => {
    const out = parseSynthesisOutput(REFUSAL_SENTINEL, 0);
    expect(out.isRefusal).toBe(true);
    expect(out.citations).toEqual([]);
  });

  it('detects the refusal sentinel with surrounding whitespace', () => {
    const out = parseSynthesisOutput(`  ${REFUSAL_SENTINEL}\n`, 0);
    expect(out.isRefusal).toBe(true);
  });

  it('does NOT treat partial-match as refusal', () => {
    const out = parseSynthesisOutput('No relevant context. Maybe try again [1].', 1);
    expect(out.isRefusal).toBe(false);
    // The trailing citation is still extracted normally.
    expect(out.citations.map((c) => c.rank)).toEqual([1]);
  });
});

describe('citationsToRanks (legacy bridge helper)', () => {
  it('deduplicates and sorts ranks', () => {
    const out = parseSynthesisOutput('First [3: "c"] then [1: "a"] then [2: "b"] then [1: "again"].', 3);
    expect(citationsToRanks(out.citations)).toEqual([1, 2, 3]);
  });

  it('returns [] for empty input', () => {
    expect(citationsToRanks([])).toEqual([]);
  });
});

describe('buildSystemPrefix', () => {
  it('marks ONLY the last block with cache_control: ephemeral', () => {
    const blocks = buildSystemPrefix();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    for (let i = 0; i < blocks.length - 1; i++) {
      expect(blocks[i]!.cache_control).toBeUndefined();
    }
  });

  it('combined prefix text clears the ≥4096-token cacheable-prefix proxy (16k chars)', () => {
    const blocks = buildSystemPrefix();
    const combined = blocks.map((b) => b.text).join('');
    expect(combined.length).toBeGreaterThanOrEqual(HAIKU_CACHE_MIN_CHAR_PROXY);
  });

  it('includes the refusal sentinel verbatim so the model is anchored on the exact string', () => {
    const blocks = buildSystemPrefix();
    const combined = blocks.map((b) => b.text).join('');
    expect(combined).toContain(REFUSAL_SENTINEL);
  });

  it('contains at least one refusal example so the model learns refusal behavior', () => {
    const blocks = buildSystemPrefix();
    const combined = blocks.map((b) => b.text).join('');
    // Refusal examples emit the exact sentinel as the answer; expect ≥2 occurrences
    // (one in instructions, plus at least one example using it).
    const occurrences = combined.split(REFUSAL_SENTINEL).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('teaches the new quote format via at least one example with [N: "..."]', () => {
    const blocks = buildSystemPrefix();
    const combined = blocks.map((b) => b.text).join('');
    expect(/\[\d+:\s*"/.test(combined)).toBe(true);
  });
});
