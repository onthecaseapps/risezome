import { RisezomeError } from '@risezome/shared-types';

export interface SynthesisSource {
  readonly rank: number;
  readonly title: string;
  readonly text: string;
}

export interface SynthesisInput {
  readonly utterance: string;
  readonly sources: readonly SynthesisSource[];
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
