import { describe, expect, it } from 'vitest';
import {
  buildSystemPrefix,
  buildUserMessage,
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

describe('parseSynthesisOutput', () => {
  it('extracts citations [1] and [2] from a normal answer', () => {
    const out = parseSynthesisOutput('The view is planned [1] but not built [2].', 3);
    expect(out.citations).toEqual([1, 2]);
    expect(out.isRefusal).toBe(false);
    expect(out.text).toBe('The view is planned [1] but not built [2].');
  });

  it('drops out-of-range citation [5] when only 3 sources were provided', () => {
    const out = parseSynthesisOutput('Per [5] the planning is in progress.', 3);
    expect(out.citations).toEqual([]);
    expect(out.isRefusal).toBe(false);
  });

  it('deduplicates repeated citations', () => {
    const out = parseSynthesisOutput('Per [1] and [1] again [2].', 3);
    expect(out.citations).toEqual([1, 2]);
  });

  it('returns empty citations when the answer has none', () => {
    const out = parseSynthesisOutput('Just text.', 3);
    expect(out.citations).toEqual([]);
    expect(out.isRefusal).toBe(false);
  });

  it('returns sorted citation list even when LLM emits out of order', () => {
    const out = parseSynthesisOutput('First [3] then [1] then [2].', 3);
    expect(out.citations).toEqual([1, 2, 3]);
  });

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
    expect(out.citations).toEqual([1]);
  });

  it('drops a mix of valid and invalid citation numbers', () => {
    const out = parseSynthesisOutput('A [1], B [99], C [2], D [0].', 2);
    expect(out.citations).toEqual([1, 2]);
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
});
