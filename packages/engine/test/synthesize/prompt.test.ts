import { describe, expect, it } from 'vitest';
import {
  buildSystemPrefix,
  buildUserMessage,
  citationsToRanks,
  HAIKU_CACHE_MIN_CHAR_PROXY,
  parseSynthesisOutput,
  stripStatusPrefix,
  verifyCitations,
  verifyCitationsDetailed,
  REFUSAL_SENTINEL,
  STATUS_ANSWER,
  STATUS_NO_CONTEXT,
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

  it('splits a U8-expanded source into matched-excerpt + surrounding-context blocks', () => {
    const expanded: SynthesisSource = {
      rank: 1,
      title: 'apps/bot-worker/src/debug/deepgram.ts',
      text: 'preamble about the engine\n\nexponential backoff reconnection (max 3 attempts)\n\nteardown notes',
      focus: 'exponential backoff reconnection (max 3 attempts)',
    };
    const out = buildUserMessage('deepgram reconnect', [expanded]);
    expect(out).toContain('Matched excerpt (judge relevance to the question from THIS):');
    expect(out).toContain('Surrounding context');
    // The tight excerpt and the wider body both appear.
    expect(out).toContain('exponential backoff reconnection (max 3 attempts)');
    expect(out).toContain('teardown notes');
  });

  it('renders the plain single-block form when focus equals text (expansion was a no-op)', () => {
    const noop: SynthesisSource = { rank: 1, title: 'f.ts', text: 'body', focus: 'body' };
    const out = buildUserMessage('q', [noop]);
    expect(out).toBe('Utterance: q\n\nSources:\n[1] f.ts\nbody');
    expect(out).not.toContain('Matched excerpt');
  });

  it('frames recentContext as a window the model must read as one thought', () => {
    const out = buildUserMessage('what ai models', SAMPLE_SOURCES, ['models are used here']);
    // The window is presented as joint context, with explicit instruction not
    // to judge the most recent line alone (the bug this fixes).
    expect(out).toContain('Read these lines together as one ongoing thought');
    expect(out).toContain('do not ');
    expect(out).toContain('judge the most recent line in isolation');
    // Both lines are present; the latest is labeled as the focus, the prior as context.
    expect(out).toContain('1. "models are used here"');
    expect(out).toContain('Most recent line: what ai models');
    expect(out).toContain('Sources:');
  });

  // --- Self-healing: suspect/repaired tool source (U5) ---

  it('flags a suspect tool source with an [UNCERTAIN] marker and keeps its caveat', () => {
    const suspect: SynthesisSource = {
      rank: 0,
      title: 'Tool: github_count({"labels":["case"]})',
      text: "Note: There's no 'case' label — showing all open issues.\n\n47 open issues.",
      suspect: true,
    };
    const out = buildUserMessage('how many open case issues', [suspect]);
    expect(out).toContain('[UNCERTAIN: read the Note before stating its numbers]');
    expect(out).toContain("Note: There's no 'case' label");
  });

  it('renders a non-suspect source unchanged (no UNCERTAIN marker)', () => {
    const out = buildUserMessage('post meeting summary view', SAMPLE_SOURCES);
    expect(out).not.toContain('UNCERTAIN');
  });

  // B2: a tool source carries `rank: 0` (telemetry marker). Sources are numbered
  // by 1-indexed POSITION so it renders as [1], not [0] — otherwise the model
  // cites [0], the verifier computes sources[-1], and the skill answer is dropped.
  it('numbers a rank-0 tool source by position → [1], never [0]', () => {
    const tool: SynthesisSource = { rank: 0, title: 'Tool: github_count({})', text: '47 open issues.' };
    const out = buildUserMessage('how many issues', [tool]);
    expect(out).toContain('[1] Tool: github_count({})');
    expect(out).not.toContain('[0]');
  });

  it('numbers a tool source + RAG sources contiguously from [1] by position', () => {
    const tool: SynthesisSource = { rank: 0, title: 'Tool: github_count({})', text: '47 open issues.' };
    const out = buildUserMessage('how many issues', [tool, SAMPLE_SOURCES[0]!]);
    expect(out).toContain('[1] Tool: github_count({})');
    expect(out).toContain('[2] Issue #6');
  });
});

describe('verifyCitationsDetailed — tool source grounding (B2)', () => {
  it('verifies a [1] citation against a rank-0 tool source at index 0', () => {
    const sources = [{ text: '47 open issues.' }];
    const detail = verifyCitationsDetailed(
      [{ rank: 1, position: 0, quote: '47 open issues' }],
      sources,
    );
    expect(detail).toHaveLength(1);
    expect(detail[0]!.status).toBe('verified');
  });

  it('keeps a bare [1] tool citation (no quote) verified', () => {
    const sources = [{ text: '47 open issues.' }];
    const detail = verifyCitationsDetailed([{ rank: 1, position: 0, quote: undefined }], sources);
    expect(detail[0]!.status).toBe('verified');
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

describe('parseSynthesisOutput — STATUS protocol', () => {
  it('STATUS: answer → answer, status line stripped from text, citations parsed', () => {
    const out = parseSynthesisOutput(`${STATUS_ANSWER}\nClaude Haiku 4.5 is used [1: "haiku"].`, 2);
    expect(out.isRefusal).toBe(false);
    expect(out.text).toBe('Claude Haiku 4.5 is used [1: "haiku"].');
    expect(out.citations.map((c) => c.rank)).toEqual([1]);
    // Citation positions are relative to the stripped body, not the raw text.
    expect(out.text.slice(out.citations[0]!.position)).toContain('[1:');
  });

  it('STATUS: no_relevant_context with a reason → refusal, reason captured, no body', () => {
    const out = parseSynthesisOutput(`${STATUS_NO_CONTEXT}\nThe window is about lunch.`, 3);
    expect(out.isRefusal).toBe(true);
    expect(out.text).toBe('');
    expect(out.citations).toEqual([]);
    expect(out.refusalReason).toBe('The window is about lunch.');
  });

  it('STATUS: no_relevant_context with no reason → refusal, no refusalReason', () => {
    const out = parseSynthesisOutput(STATUS_NO_CONTEXT, 0);
    expect(out.isRefusal).toBe(true);
    expect(out.refusalReason).toBeUndefined();
  });

  it('tolerates a missing space and case variance in the tag', () => {
    expect(parseSynthesisOutput('status:no_relevant_context\nx', 0).isRefusal).toBe(true);
    expect(parseSynthesisOutput('STATUS:answer\nhi [1].', 1).isRefusal).toBe(false);
  });
});

describe('parseSynthesisOutput — legacy sentinel fallback (no STATUS tag)', () => {
  it('bare sentinel → refusal', () => {
    const out = parseSynthesisOutput(REFUSAL_SENTINEL, 0);
    expect(out.isRefusal).toBe(true);
    expect(out.citations).toEqual([]);
  });

  it('sentinel with surrounding whitespace → refusal', () => {
    expect(parseSynthesisOutput(`  ${REFUSAL_SENTINEL}\n`, 0).isRefusal).toBe(true);
  });

  it('sentinel FOLLOWED BY prose → refusal (the prod ugly-card bug)', () => {
    // This is the exact failure mode: the model emitted the sentinel plus a
    // verbose explanation, which exact-match missed and rendered as a card.
    const out = parseSynthesisOutput(
      'No relevant context. The sources discuss models but the utterance is a fragment.',
      2,
    );
    expect(out.isRefusal).toBe(true);
    expect(out.text).toBe('');
  });

  it('ordinary answer with no tag and no sentinel → answer', () => {
    const out = parseSynthesisOutput('The view is planned [1] but not built [2].', 3);
    expect(out.isRefusal).toBe(false);
    expect(out.citations.map((c) => c.rank)).toEqual([1, 2]);
  });
});

describe('stripStatusPrefix — streaming gate', () => {
  it('holds (incomplete) while the STATUS line is still forming', () => {
    for (const partial of ['', 'S', 'STAT', 'STATUS:', 'STATUS: ', 'STATUS: ans', 'STATUS: answer']) {
      expect(stripStatusPrefix(partial).complete).toBe(false);
    }
  });

  it('resolves once the STATUS: answer line ends, exposing the streamed body', () => {
    const g1 = stripStatusPrefix(`${STATUS_ANSWER}\n`);
    expect(g1).toMatchObject({ complete: true, status: 'answer', body: '' });
    const g2 = stripStatusPrefix(`${STATUS_ANSWER}\nClaude Haiku`);
    expect(g2).toMatchObject({ complete: true, status: 'answer', body: 'Claude Haiku' });
  });

  it('resolves a refusal without ever exposing a body', () => {
    const g = stripStatusPrefix(`${STATUS_NO_CONTEXT}\nbecause lunch`);
    expect(g).toMatchObject({ complete: true, status: 'no_relevant_context', body: '', reason: 'because lunch' });
  });

  it('streams immediately when output diverges from the protocol (legacy prose)', () => {
    const g = stripStatusPrefix('The plan is [1].');
    expect(g).toMatchObject({ complete: true, status: 'answer', body: 'The plan is [1].' });
  });

  it('classifies a legacy bare-sentinel refusal without a body', () => {
    const g = stripStatusPrefix('No relevant context. unrelated sources.');
    expect(g).toMatchObject({ complete: true, status: 'no_relevant_context', body: '' });
  });

  it('holds on a LEADING newline/whitespace-only delta (the gate must not open before the STATUS line)', () => {
    // Models routinely open with a bare "\n" delta. Pre-fix, the gate
    // classified it as a complete ANSWER and began streaming — letting a
    // refusal that followed briefly stream (R1 violation).
    for (const partial of ['\n', '\n\n', '  \n', '\nSTATUS:', '\nSTATUS: answer']) {
      expect(stripStatusPrefix(partial).complete).toBe(false);
    }
  });

  it('still resolves a newline-led STATUS line once complete', () => {
    const g = stripStatusPrefix(`\n${STATUS_NO_CONTEXT}\nreason here`);
    expect(g).toMatchObject({ complete: true, status: 'no_relevant_context', body: '' });
    const a = stripStatusPrefix(`\n${STATUS_ANSWER}\nThe answer.`);
    expect(a).toMatchObject({ complete: true, status: 'answer', body: 'The answer.' });
  });

  it('still streams newline-led NON-protocol output (legacy divergence)', () => {
    const g = stripStatusPrefix('\nThe plan is [1]. And more prose follows here.');
    expect(g.complete).toBe(true);
    expect(g.status).toBe('answer');
  });
});

describe('CITATION_REGEX — adversarial input (ReDoS guard)', () => {
  it('parses a long unterminated backslash run promptly instead of backtracking exponentially', () => {
    const adversarial = 'STATUS: answer\nAnswer [1: "' + '\\'.repeat(400);
    const startedAt = Date.now();
    const parsed = parseSynthesisOutput(adversarial, 3);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(parsed.isRefusal).toBe(false);
  });
});

describe('verifyCitations — drops fabricated quoted citations', () => {
  const sources = [
    { text: 'The hold lasts 10 minutes and is keyed by a hold token.' },
    { text: 'Cancellation within 7 days charges 50% of the subtotal.' },
  ];

  it('keeps a quoted citation whose quote is present in the cited source', () => {
    const out = verifyCitations(
      [{ rank: 1, position: 0, quote: 'hold lasts 10 minutes' }],
      sources,
    );
    expect(out.verified).toHaveLength(1);
    expect(out.droppedQuoted).toBe(0);
  });

  it('drops a quoted citation whose quote is NOT in the cited source (fabrication)', () => {
    const out = verifyCitations(
      [{ rank: 1, position: 0, quote: 'uses Claude Haiku 4.5' }],
      sources,
    );
    expect(out.verified).toEqual([]);
    expect(out.droppedQuoted).toBe(1);
  });

  it('matches tolerant of whitespace + case drift', () => {
    const out = verifyCitations(
      [{ rank: 2, position: 0, quote: 'charges 50%   of the SUBTOTAL' }],
      sources,
    );
    expect(out.verified).toHaveLength(1);
  });

  it('matches tolerant of punctuation/apostrophe drift (loose fallback)', () => {
    // Source has "users sources" (no apostrophe); model "tidied" to "user's".
    const apostropheSources = [{ text: 'log questions grounded in the users sources here.' }];
    const out = verifyCitations(
      [{ rank: 1, position: 0, quote: "grounded in the user's sources" }],
      apostropheSources,
    );
    expect(out.verified).toHaveLength(1);
    expect(out.droppedQuoted).toBe(0);
  });

  it('loose fallback still rejects genuinely different words (no fabrication pass-through)', () => {
    const out = verifyCitations(
      [{ rank: 1, position: 0, quote: 'grounded in the admin sources' }],
      [{ text: 'log questions grounded in the users sources here.' }],
    );
    expect(out.verified).toEqual([]);
    expect(out.droppedQuoted).toBe(1);
  });

  it('verifies a quote that is in the matched-excerpt focus but not the expanded text', () => {
    // U8 can expand a matched SUMMARY chunk to body chunks (summary excluded),
    // so the quote the model took from the focus isn't in `text`. The focus is
    // real retrieved content the model was shown, so it must still verify.
    const out = verifyCitations(
      [{ rank: 1, position: 0, quote: 'DEFAULT_RRF_K=60' }],
      [{ text: 'unrelated body chunk about fusion math', focus: 'corpus-search constants: DEFAULT_RRF_K = 60, floor 0.45' }],
    );
    expect(out.verified).toHaveLength(1);
    expect(out.verified[0]!.quote).toBe('DEFAULT_RRF_K=60'); // kept as a full (highlightable) quote
    expect(out.droppedQuoted).toBe(0);
  });

  describe('paraphrase downgrade (keep a bare citation instead of suppressing)', () => {
    const corpusSearch = [
      {
        text: 'Hybrid corpus retrieval: dense (pgvector cosine) + lexical (Postgres full-text) fused with Reciprocal Rank Fusion.',
      },
    ];

    it('downgrades a reworded quote that shares a long fragment to a BARE citation', () => {
      // The model paraphrased inside the quote marks ("combining dense vector
      // search ...") but shares the verbatim run "hybrid corpus retrieval".
      const out = verifyCitations(
        [{ rank: 1, position: 0, quote: 'hybrid corpus retrieval combining dense vector search (pgvector cosine distance)' }],
        corpusSearch,
      );
      expect(out.verified).toHaveLength(1);
      expect(out.verified[0]!.quote).toBeUndefined(); // quote stripped → bare
      expect(out.verified[0]!.rank).toBe(1); // citation (and grounding) preserved
      expect(out.downgradedToBare).toBe(1);
      expect(out.droppedQuoted).toBe(0);
    });

    it('drops (does not downgrade) a quote with no substantial shared fragment', () => {
      const out = verifyCitations(
        [{ rank: 1, position: 0, quote: 'the project uses a graph database with gremlin traversals' }],
        corpusSearch,
      );
      expect(out.verified).toEqual([]);
      expect(out.downgradedToBare).toBe(0);
      expect(out.droppedQuoted).toBe(1);
    });
  });

  it('keeps bare [N] citations (no quote to verify)', () => {
    const out = verifyCitations([{ rank: 1, position: 0, quote: undefined }], sources);
    expect(out.verified).toHaveLength(1);
    expect(out.droppedQuoted).toBe(0);
  });

  it('drops a quote whose rank points past the source list', () => {
    const out = verifyCitations([{ rank: 9, position: 0, quote: 'anything' }], sources);
    expect(out.verified).toEqual([]);
    expect(out.droppedQuoted).toBe(1);
  });

  describe('same-document fallback (one doc split across ranks)', () => {
    // docA is surfaced as ranks 1 and 3 (two chunks); docB as rank 2.
    const docSplit = [
      { text: 'Intro paragraph about the gap-fill feature.', docId: 'docA' },
      { text: 'Unrelated content about pricing.', docId: 'docB' },
      { text: 'When a flagged question yields no source result above the threshold, a gap card appears.', docId: 'docA' },
    ];

    it('keeps a quote the model cited at rank 1 but which lives in a sibling chunk of the same doc (rank 3)', () => {
      const out = verifyCitations(
        [{ rank: 1, position: 0, quote: 'a flagged question yields no source result' }],
        docSplit,
      );
      expect(out.verified).toHaveLength(1);
      expect(out.droppedQuoted).toBe(0);
      // Rank is left unchanged (no re-attribution).
      expect(out.verified[0]!.rank).toBe(1);
    });

    it('still drops a quote that is in a DIFFERENT document than the cited rank (cross-doc fabrication)', () => {
      // Cited rank 1 = docA; the quote is verbatim only in docB (rank 2).
      const out = verifyCitations(
        [{ rank: 1, position: 0, quote: 'Unrelated content about pricing' }],
        docSplit,
      );
      expect(out.verified).toEqual([]);
      expect(out.droppedQuoted).toBe(1);
    });

    it('does not apply the fallback when sources carry no docId (behaves as chunk-level)', () => {
      const out = verifyCitations(
        [{ rank: 1, position: 0, quote: 'gap card appears' }],
        [{ text: 'Intro paragraph.' }, { text: 'a gap card appears here' }],
      );
      expect(out.verified).toEqual([]);
      expect(out.droppedQuoted).toBe(1);
    });
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

  it('carries the suspect-result honesty rule (U5) so a repaired number is never stated bare', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    expect(combined).toContain('DO NOT STATE A FLAGGED-UNCERTAIN RESULT AS A PLAIN FACT');
    expect(combined).toContain('[UNCERTAIN');
  });

  it('anchors the model on both STATUS tags', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    expect(combined).toContain(STATUS_ANSWER);
    expect(combined).toContain(STATUS_NO_CONTEXT);
  });

  it('contains at least one refusal example (STATUS: no_relevant_context in an Answer block)', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    // ≥2 occurrences: the protocol explanation plus at least one worked example.
    const occurrences = combined.split(STATUS_NO_CONTEXT).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('teaches assembling the question from a window via a fragment example', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    expect(combined).toContain('Most recent line: when does it kick in');
  });

  it('uses a fictional example domain (no real product stack to leak)', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    // The few-shots are about the fictional "Marina" product so the model
    // cannot recite this product's real stack as if grounded.
    expect(combined).toContain('Marina');
    for (const realFact of ['claude-haiku-4-5', 'voyage-3-large', 'Deepgram', 'Nova-3', 'Voyage AI']) {
      expect(combined.includes(realFact), `leaked real fact in prompt: ${realFact}`).toBe(false);
    }
  });

  it('teaches the new quote format via at least one example with [N: "..."]', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    expect(/\[\d+:\s*"/.test(combined)).toBe(true);
  });

  it('requires facts to be self-contained in prose, not buried inside the citation quote', () => {
    // Guards the fix for "name replaced by a citation chip": the quote is
    // invisible inline, so the fact must be stated in the prose itself.
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    expect(combined).toContain('INVISIBLE TO THE READER');
    expect(combined).toContain('NEVER put a word the sentence depends on ONLY inside the citation quote');
  });

  it('carries the no-em-dash rule', () => {
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    expect(combined).toContain('NO EM-DASHES');
  });

  it('uses no em-dash or en-dash in any worked-example answer block', () => {
    // Source snippets may legitimately contain em-dashes (they model real
    // inputs), but the ANSWER blocks are the exemplars the model imitates, so
    // they must be dash-clean to enforce rule 11.
    const combined = buildSystemPrefix().map((b) => b.text).join('');
    const answerBlocks = [...combined.matchAll(/Answer:\n([\s\S]*?)\n<\/example/g)].map((m) => m[1]!);
    expect(answerBlocks.length).toBeGreaterThan(0);
    for (const block of answerBlocks) {
      expect(block.includes('—'), `em-dash in answer block: ${block}`).toBe(false);
      expect(block.includes('–'), `en-dash in answer block: ${block}`).toBe(false);
    }
  });
});
