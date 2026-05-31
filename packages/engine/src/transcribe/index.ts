// Transcript-provider contract. Deepgram (daemon), Recall (bot-worker),
// and future providers all implement the TranscriptionEngine interface
// and emit the same Utterance shape so the rest of the engine pipeline
// is provider-agnostic.

export * from './contract.js';
