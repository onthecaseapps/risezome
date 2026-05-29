// Minimal stub: U2 replaces this file with the real cacheable system
// prefix (system prompt + few-shot examples ≥ 4096 tokens), the proper
// user-message formatter, and the citation extractor. The shape stays
// stable so U1's tests continue to drive the client through these
// functions unchanged.

import type { SynthesisSource } from './contract.js';

export interface SystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
}

export const REFUSAL_SENTINEL = 'No relevant context.';

export function buildSystemBlocks(): SystemBlock[] {
  // U2 fills with real system prompt + 5-7 few-shot examples and marks the
  // last block with cache_control. For U1's tests we ship a minimal block
  // so the request shape (system: array, last block has cache_control) is
  // already correct end-to-end.
  return [
    {
      type: 'text',
      text: 'You synthesize retrieved snippets to answer one live utterance. (stub — U2 fills the real prompt.)',
      cache_control: { type: 'ephemeral' },
    },
  ];
}

export function buildUserMessage(utterance: string, sources: readonly SynthesisSource[]): string {
  const numbered = sources
    .map((s) => `[${String(s.rank)}] ${s.title}\n${s.text}`)
    .join('\n\n');
  return `Utterance: ${utterance}\n\nSources:\n${numbered}`;
}

export interface ParsedSynthesis {
  readonly text: string;
  readonly citations: readonly number[];
  readonly isRefusal: boolean;
}

export function parseSynthesisOutput(text: string, sourceCount: number): ParsedSynthesis {
  if (text.trim() === REFUSAL_SENTINEL) {
    return { text, citations: [], isRefusal: true };
  }
  const seen = new Set<number>();
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= sourceCount) seen.add(n);
  }
  return { text, citations: [...seen].sort((a, b) => a - b), isRefusal: false };
}
