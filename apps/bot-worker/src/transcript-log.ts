/**
 * Redaction helper for transcript bodies in logs (U6 / S4).
 *
 * Spoken customer transcript text is the most sensitive PII the bot-worker
 * handles. It must NOT land in logs by default — logs flow to disk
 * (`.dev-logs/`), the dev-console browser stream, and the production log
 * aggregator, none of which have the RLS/participant scoping that protects the
 * transcript rows in Postgres.
 *
 * Use `transcriptLogFields(text)` in any log payload that would otherwise carry
 * an utterance body. It always returns a length (useful for debugging cadence)
 * and includes the verbatim `text` ONLY when `LOG_TRANSCRIPTS=1` is explicitly
 * set — off by default, never on in production.
 */
export function logTranscripts(): boolean {
  return process.env.LOG_TRANSCRIPTS === '1';
}

export function transcriptLogFields(text: string): Record<string, unknown> {
  return logTranscripts() ? { textLen: text.length, text } : { textLen: text.length };
}
