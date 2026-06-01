// RAGAS-style retrieval+answer quality metrics, reimplemented as Claude
// LLM-judge prompts in TypeScript (KTD-1 in the Claude-augmented RAG plan).
// No ground-truth answers are required — the judge scores against the
// question, the retrieved contexts, and the produced answer.
//
// The metric functions take an injected `Judge` so they unit-test against a
// mocked judge; `makeAnthropicJudge` provides the production judge. A judge
// or parse failure surfaces as a `null` score (recorded, not fatal) so one
// bad metric never sinks an eval run.

export interface RagasInput {
  readonly question: string;
  readonly answer: string;
  /** Retrieved chunk texts that were available to the synthesizer. */
  readonly contexts: readonly string[];
}

/** Injected LLM judge: takes a prompt, returns the model's raw text. */
export type Judge = (prompt: string) => Promise<string>;

export interface RagasScores {
  /** Fraction of answer claims supported by the contexts (0–1). */
  readonly faithfulness: number | null;
  /** How well the answer addresses the question (0–1). */
  readonly answerRelevancy: number | null;
  /** Fraction of retrieved contexts that are relevant to the answer (0–1). */
  readonly contextPrecision: number | null;
  /** Whether the contexts contain support for the answer's claims (0–1). */
  readonly contextRecall: number | null;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Extract the first JSON object/array from judge text, tolerating prose
 *  preamble or ```json fences. Throws if none is parseable. */
export function parseJsonVerdict(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error('no JSON found in judge output');
  // Walk to the matching closer.
  const open = candidate[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON in judge output');
}

function numbersFromBools(items: { supported?: boolean; relevant?: boolean; used?: boolean }[]): number | null {
  if (items.length === 0) return null;
  const yes = items.filter((it) => it.supported === true || it.relevant === true || it.used === true).length;
  return yes / items.length;
}

const ctxBlock = (contexts: readonly string[]): string =>
  contexts.map((c, i) => `[${String(i + 1)}] ${c}`).join('\n\n');

export async function computeFaithfulness(input: RagasInput, judge: Judge): Promise<number | null> {
  const prompt =
    `You are scoring FAITHFULNESS. Break the ANSWER into atomic factual claims, then mark each claim true if it is supported by the CONTEXTS, false otherwise. Respond ONLY with JSON: {"claims":[{"claim":"...","supported":true|false}]}.\n\n` +
    `QUESTION: ${input.question}\n\nANSWER: ${input.answer}\n\nCONTEXTS:\n${ctxBlock(input.contexts)}`;
  const v = parseJsonVerdict(await judge(prompt)) as { claims?: { supported?: boolean }[] };
  return numbersFromBools(v.claims ?? []);
}

export async function computeAnswerRelevancy(input: RagasInput, judge: Judge): Promise<number | null> {
  const prompt =
    `You are scoring ANSWER RELEVANCY: how directly does the ANSWER address the QUESTION (ignore correctness, only relevance)? Respond ONLY with JSON: {"score": <number 0..1>}.\n\n` +
    `QUESTION: ${input.question}\n\nANSWER: ${input.answer}`;
  const v = parseJsonVerdict(await judge(prompt)) as { score?: number };
  return typeof v.score === 'number' ? clamp01(v.score) : null;
}

export async function computeContextPrecision(input: RagasInput, judge: Judge): Promise<number | null> {
  const prompt =
    `You are scoring CONTEXT PRECISION. For each numbered CONTEXT, mark relevant true if it contributes information used by or relevant to the ANSWER, false if it is noise. Respond ONLY with JSON: {"contexts":[{"index":1,"relevant":true|false}, ...]}.\n\n` +
    `QUESTION: ${input.question}\n\nANSWER: ${input.answer}\n\nCONTEXTS:\n${ctxBlock(input.contexts)}`;
  const v = parseJsonVerdict(await judge(prompt)) as { contexts?: { relevant?: boolean }[] };
  return numbersFromBools(v.contexts ?? []);
}

export async function computeContextRecall(input: RagasInput, judge: Judge): Promise<number | null> {
  const prompt =
    `You are scoring CONTEXT RECALL. Break the ANSWER into atomic claims, then mark each claim attributable true if the CONTEXTS contain enough to support it, false otherwise. Respond ONLY with JSON: {"claims":[{"claim":"...","supported":true|false}]}.\n\n` +
    `QUESTION: ${input.question}\n\nANSWER: ${input.answer}\n\nCONTEXTS:\n${ctxBlock(input.contexts)}`;
  const v = parseJsonVerdict(await judge(prompt)) as { claims?: { supported?: boolean }[] };
  return numbersFromBools(v.claims ?? []);
}

/** Run all four metrics; each degrades to null on judge/parse failure. */
export async function scoreRagas(input: RagasInput, judge: Judge): Promise<RagasScores> {
  const safe = async (fn: () => Promise<number | null>): Promise<number | null> => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const [faithfulness, answerRelevancy, contextPrecision, contextRecall] = await Promise.all([
    safe(() => computeFaithfulness(input, judge)),
    safe(() => computeAnswerRelevancy(input, judge)),
    safe(() => computeContextPrecision(input, judge)),
    safe(() => computeContextRecall(input, judge)),
  ]);
  return { faithfulness, answerRelevancy, contextPrecision, contextRecall };
}

/** Mean of each metric across many results, ignoring nulls. */
export function meanScores(all: readonly RagasScores[]): RagasScores {
  const mean = (key: keyof RagasScores): number | null => {
    const vals = all.map((s) => s[key]).filter((v): v is number => v !== null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return {
    faithfulness: mean('faithfulness'),
    answerRelevancy: mean('answerRelevancy'),
    contextPrecision: mean('contextPrecision'),
    contextRecall: mean('contextRecall'),
  };
}
