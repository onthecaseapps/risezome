import { RisezomeError } from '@risezome/shared-types';

export interface SynthesisSource {
  readonly rank: number;
  readonly title: string;
  /** The text the model synthesizes from. With parent-document retrieval
   *  (U8) this is the EXPANDED parent context; otherwise it's the chunk body. */
  readonly text: string;
  /** Parent-document retrieval (U8): the tight child excerpt that actually
   *  matched the query, when `text` has been expanded to wider parent context.
   *  The model judges topical RELEVANCE from this focus excerpt (so wider
   *  surrounding context can't make a precise-lookup source read as
   *  off-topic), then draws on the full `text` to compose a complete answer.
   *  Omitted (or equal to `text`) when no expansion happened — render falls
   *  back to the plain single-block form. `focus` is always a substring of
   *  `text`, so citation quotes still verify against `text`. */
  readonly focus?: string;
  /** Source document id. When several retrieved chunks of ONE document are
   *  surfaced as separate sources, a verbatim quote can land in a sibling
   *  chunk's text while the model cites a different rank. Citation
   *  verification uses docId to accept a quote that is verbatim in ANY
   *  retrieved source of the cited document (still grounded), instead of
   *  dropping it for being absent from the single cited chunk. */
  readonly docId?: string;
}

export interface SynthesisInput {
  readonly utterance: string;
  readonly sources: readonly SynthesisSource[];
  /** Recent prior utterances (oldest first, EXCLUDING the current
   *  `utterance`). When provided, the user message includes them as
   *  context so Claude can resolve pronouns and fragments — "in the
   *  app and where in the code base are they" stops being meaningless
   *  in isolation when "are any LLMs leveraged" precedes it. */
  readonly recentContext?: readonly string[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface SynthesisUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

// Chunks yielded by the synthesizer's AsyncIterable. Errors throw out
// of the iterator's next() (standard JS convention) rather than being
// emitted as chunks — the caller catches via try/catch around for-await.
export type SynthesisChunk =
  | {
      readonly type: 'start';
      readonly synthesisId: string;
      readonly model: string;
      readonly usage: SynthesisUsage;
    }
  | { readonly type: 'textDelta'; readonly synthesisId: string; readonly delta: string }
  | {
      readonly type: 'done';
      readonly synthesisId: string;
      readonly stopReason: string;
      readonly usage: SynthesisUsage;
    };

export interface Synthesizer {
  synthesize(input: SynthesisInput, signal?: AbortSignal): AsyncIterable<SynthesisChunk>;
}

// Discriminates the variety of provider failures the pipeline may want
// to surface differently in logs / telemetry. The base RisezomeError code
// stays 'synthesis-provider' so retry-decision logic can match the
// class; `kind` carries the diagnostic dimension.
export type SynthesisProviderErrorKind =
  | 'auth-error'
  | 'bad-request'
  | 'network-error'
  | 'overloaded'
  | 'server-error'
  | 'request-too-large'
  | 'unknown';

export class SynthesisProviderError extends RisezomeError {
  readonly kind: SynthesisProviderErrorKind;
  constructor(kind: SynthesisProviderErrorKind, message: string, options?: ErrorOptions) {
    super('synthesis-provider', message, options);
    this.kind = kind;
  }
}

export class SynthesisRateLimitError extends RisezomeError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, options?: ErrorOptions) {
    super('synthesis-rate-limit', message, options);
    this.retryAfterMs = retryAfterMs;
  }
}
