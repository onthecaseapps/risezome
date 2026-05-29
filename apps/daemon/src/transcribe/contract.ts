import type { EventEmitter } from 'node:events';
import { UpwellError } from '@upwell/shared-types';

export interface Utterance {
  readonly utteranceId: string;
  readonly text: string;
  readonly isFinal: boolean;
  readonly speaker?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly revision: number;
  readonly confidence?: number;
}

export interface PartialTranscript {
  readonly utterance: Utterance;
}

export interface FinalTranscript {
  readonly utterance: Utterance;
}

export interface SpeakerChange {
  readonly speaker: string;
  readonly atMs: number;
}

export interface TranscriptionEngineEvents {
  partial: [PartialTranscript];
  final: [FinalTranscript];
  speakerChange: [SpeakerChange];
  disconnected: [{ readonly reason: string }];
  stopped: [{ readonly reason?: string }];
  error: [Error];
}

export interface TranscriptionEngine extends EventEmitter<TranscriptionEngineEvents> {
  start(): Promise<void>;
  sendFrame(samples: Int16Array): void;
  stop(): Promise<void>;
}

export class TranscriptionAuthError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('transcription-auth', message, options);
  }
}

export class TranscriptionConnectionError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('transcription-connection', message, options);
  }
}
