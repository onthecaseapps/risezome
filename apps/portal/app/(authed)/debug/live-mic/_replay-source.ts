/**
 * Transcript replay source (U2). A `ReplayUtterance` is the minimal finalized-
 * utterance shape the replay driver feeds to the sidecar — shared by the
 * meeting-ID decrypt route (server) and the client file parser. No React / DOM
 * deps, so both server and client can import it.
 */

import type { TranscriptRow } from '../../../_lib/transcript';

export interface ReplayUtterance {
  readonly utteranceId: string;
  readonly text: string;
  readonly speaker: string | null;
  /** Milliseconds from meeting start; drives replay cadence. */
  readonly startMs: number;
}

/**
 * Map decrypted transcript rows (from `transcriptWithText`) to ordered replay
 * utterances. Pure (the meeting-ID decrypt route is a thin wrapper around this).
 * Rows without usable text or an utteranceId are dropped; output is sorted by
 * startMs so cadence is monotonic.
 */
export function toReplayUtterances(rows: readonly TranscriptRow[]): ReplayUtterance[] {
  const out: ReplayUtterance[] = [];
  for (const r of rows) {
    const p = r.payload ?? {};
    const text = r.text;
    const utteranceId = p['utteranceId'];
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      typeof utteranceId !== 'string' ||
      utteranceId.length === 0
    ) {
      continue;
    }
    const speaker = p['speaker'];
    const startMs = p['startMs'];
    out.push({
      utteranceId,
      text,
      speaker: typeof speaker === 'string' && speaker.length > 0 ? speaker : null,
      startMs: typeof startMs === 'number' && Number.isFinite(startMs) ? startMs : 0,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** `[mm:ss] Speaker: text` (mm may exceed 59). Speaker segment is optional. */
const LINE_RE = /^\s*\[(\d+):([0-5]?\d)\]\s*(?:([^:]+?):\s*)?(.*)$/;

function clockToMs(min: number, sec: number): number {
  return (min * 60 + sec) * 1000;
}

/**
 * Parse a pasted/uploaded transcript into ordered replay utterances. Accepts
 * either a JSON array of `{ text, speaker?, startMs?, utteranceId? }` or plain
 * lines in `[mm:ss] Speaker: text` form (what buildTranscriptText emits, so a
 * recap-style copy round-trips). Lines that don't match are skipped, not fatal.
 * Output is sorted by startMs so cadence is monotonic regardless of input order.
 */
export function parseTranscriptFile(raw: string): ReplayUtterance[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  // JSON array path.
  if (trimmed.startsWith('[') && trimmed.includes('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const out: ReplayUtterance[] = [];
        parsed.forEach((row, i) => {
          if (row === null || typeof row !== 'object') return;
          const r = row as Record<string, unknown>;
          const text = typeof r.text === 'string' ? r.text.trim() : '';
          if (text.length === 0) return;
          out.push({
            utteranceId: typeof r.utteranceId === 'string' && r.utteranceId.length > 0 ? r.utteranceId : `replay-${String(i)}`,
            text,
            speaker: typeof r.speaker === 'string' && r.speaker.length > 0 ? r.speaker : null,
            startMs: typeof r.startMs === 'number' && Number.isFinite(r.startMs) ? r.startMs : i * 1000,
          });
        });
        return sortByStart(out);
      }
    } catch {
      // fall through to line parsing
    }
  }

  // `[mm:ss] Speaker: text` line path.
  const out: ReplayUtterance[] = [];
  trimmed.split('\n').forEach((line, i) => {
    const m = LINE_RE.exec(line);
    if (m === null) return;
    const text = (m[4] ?? '').trim();
    if (text.length === 0) return;
    out.push({
      utteranceId: `replay-${String(i)}`,
      text,
      speaker: m[3] !== undefined && m[3].trim().length > 0 ? m[3].trim() : null,
      startMs: clockToMs(Number(m[1]), Number(m[2])),
    });
  });
  return sortByStart(out);
}

function sortByStart(utterances: ReplayUtterance[]): ReplayUtterance[] {
  return [...utterances].sort((a, b) => a.startMs - b.startMs);
}
