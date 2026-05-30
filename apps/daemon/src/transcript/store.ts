import type { Database as DatabaseType } from 'better-sqlite3';
import type { Utterance } from '../transcribe/contract.js';
import { RisezomeError } from '@risezome/shared-types';

export class TranscriptStoreError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('transcript-store', message, options);
  }
}

export interface StoredUtterance extends Utterance {
  readonly meetingId: string;
}

interface UtteranceRow {
  utterance_id: string;
  meeting_id: string;
  stream_role: string;
  text: string;
  speaker: string | null;
  started_at: number;
  ended_at: number;
  revision: number;
}

export class TranscriptStore {
  readonly #db: DatabaseType;

  constructor(db: DatabaseType) {
    this.#db = db;
  }

  ensureMeeting(meetingId: string, title: string | null, startedAt: number): void {
    this.#db
      .prepare(`INSERT OR IGNORE INTO meetings (meeting_id, title, started_at) VALUES (?, ?, ?)`)
      .run(meetingId, title, startedAt);
  }

  endMeeting(meetingId: string, endedAt: number): void {
    this.#db
      .prepare('UPDATE meetings SET ended_at = ? WHERE meeting_id = ?')
      .run(endedAt, meetingId);
  }

  persist(utterance: StoredUtterance): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO meeting_utterances
           (utterance_id, meeting_id, stream_role, text, speaker, started_at, ended_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        utterance.utteranceId,
        utterance.meetingId,
        utterance.speaker ?? 'unknown',
        utterance.text,
        utterance.speaker ?? null,
        utterance.startMs,
        utterance.endMs,
        utterance.revision,
      );
  }

  loadRange(meetingId: string, fromMs: number, toMs: number): StoredUtterance[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM meeting_utterances
          WHERE meeting_id = ? AND ended_at >= ? AND started_at <= ?
          ORDER BY started_at ASC`,
      )
      .all(meetingId, fromMs, toMs) as UtteranceRow[];
    return rows.map((r) => rowToUtterance(r));
  }

  loadMeeting(meetingId: string): StoredUtterance[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM meeting_utterances
          WHERE meeting_id = ?
          ORDER BY started_at ASC`,
      )
      .all(meetingId) as UtteranceRow[];
    return rows.map((r) => rowToUtterance(r));
  }
}

function rowToUtterance(row: UtteranceRow): StoredUtterance {
  return {
    meetingId: row.meeting_id,
    utteranceId: row.utterance_id,
    text: row.text,
    isFinal: true,
    startMs: row.started_at,
    endMs: row.ended_at,
    revision: row.revision,
    ...(row.speaker !== null && { speaker: row.speaker }),
  };
}
