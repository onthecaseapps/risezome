import { afterEach, describe, expect, it } from 'vitest';
import { logTranscripts, transcriptLogFields } from '../src/transcript-log';

/** U6 / S4: transcript bodies are redacted from logs unless LOG_TRANSCRIPTS=1. */

afterEach(() => {
  delete process.env.LOG_TRANSCRIPTS;
});

describe('transcriptLogFields (U6)', () => {
  it('omits the verbatim text by default — only length', () => {
    delete process.env.LOG_TRANSCRIPTS;
    const fields = transcriptLogFields('the secret quarterly numbers are 4.2M');
    expect(fields).toEqual({ textLen: 37 });
    expect(fields.text).toBeUndefined();
    expect(logTranscripts()).toBe(false);
  });

  it('includes the verbatim text only when LOG_TRANSCRIPTS=1', () => {
    process.env.LOG_TRANSCRIPTS = '1';
    const fields = transcriptLogFields('hello world');
    expect(fields).toEqual({ textLen: 11, text: 'hello world' });
    expect(logTranscripts()).toBe(true);
  });

  it('treats any value other than "1" as off', () => {
    process.env.LOG_TRANSCRIPTS = 'true';
    expect(transcriptLogFields('x').text).toBeUndefined();
  });
});
