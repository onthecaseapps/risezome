import type { Utterance } from '@risezome/engine/transcribe';

/**
 * Adapts Recall.ai's realtime transcript message format to the engine's
 * `Utterance` shape. R27 — the bridge between two contracts; must be
 * precise. Fixture-based characterization tests in test/recall-adapter.test.ts
 * lock the mapping.
 *
 * Two relevant message types:
 *   - transcript.partial_data → partial utterance (engine isFinal=false)
 *   - transcript.data         → final utterance (engine isFinal=true)
 *
 * Both share the same body shape:
 *   {
 *     event: "transcript.data" | "transcript.partial_data",
 *     data: {
 *       data: {
 *         words: [{ text, start_timestamp: { relative }, end_timestamp: { relative } }],
 *         participant: { id, name?, is_host? }
 *       },
 *       realtime_endpoint: { id, ... }
 *     }
 *   }
 *
 * Identity: utteranceId is derived as `<participant.id>::<startMs>` so
 * a partial-data update for the same in-flight utterance maps to the
 * same id (Recall doesn't send an explicit utterance_id). revision
 * increments are tracked by the caller; the adapter always returns
 * revision: 0 since it has no cross-message state.
 *
 * Other event types we may see and the adapter handles gracefully by
 * returning null (caller routes elsewhere):
 *   - participant_events.join / leave  → use for speaker bookkeeping later
 *   - any unknown event                → null
 */

export interface RecallMessage {
  event?: string;
  data?: {
    data?: {
      words?: {
        text?: string;
        start_timestamp?: { relative?: number };
        end_timestamp?: { relative?: number };
      }[];
      participant?: {
        id?: number | string;
        name?: string;
        is_host?: boolean;
      };
    };
  };
}

export type AdaptedMessage =
  | { kind: 'utterance'; utterance: Utterance }
  | { kind: 'ignored'; reason: 'unknown-event' | 'malformed' | 'empty-words' };

export function adaptRecallMessage(raw: unknown): AdaptedMessage {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'ignored', reason: 'malformed' };
  }
  const msg = raw as RecallMessage;
  const event = msg.event;

  if (event !== 'transcript.data' && event !== 'transcript.partial_data') {
    return { kind: 'ignored', reason: 'unknown-event' };
  }

  const body = msg.data?.data;
  if (body === undefined) {
    return { kind: 'ignored', reason: 'malformed' };
  }

  const words = body.words;
  if (!Array.isArray(words) || words.length === 0) {
    return { kind: 'ignored', reason: 'empty-words' };
  }

  // Compose the utterance text from word tokens. Words come tokenized
  // (punctuation as separate tokens or attached — Deepgram nova-3
  // attaches punctuation). Join with single spaces; the renderer
  // doesn't care about exact spacing of punctuation.
  const text = words
    .map((w) => (typeof w.text === 'string' ? w.text : ''))
    .filter((t) => t.length > 0)
    .join(' ');

  if (text.length === 0) {
    return { kind: 'ignored', reason: 'empty-words' };
  }

  const startMs = Math.round((words[0]?.start_timestamp?.relative ?? 0) * 1000);
  const lastEndRelative = words[words.length - 1]?.end_timestamp?.relative;
  const endMs = lastEndRelative !== undefined
    ? Math.round(lastEndRelative * 1000)
    : startMs;

  const participant = body.participant;
  const speaker = typeof participant?.name === 'string' && participant.name.length > 0
    ? participant.name
    : undefined;

  // Stable id across partial + final messages for the same utterance:
  // bind to (participantId, startMs). Recall doesn't expose an explicit
  // utterance_id but partials for the same speech share the same
  // start_timestamp on the first word.
  const participantPart = participant?.id !== undefined ? String(participant.id) : 'unknown';
  const utteranceId = `${participantPart}::${startMs}`;

  const utterance: Utterance = {
    utteranceId,
    text,
    isFinal: event === 'transcript.data',
    ...(speaker !== undefined ? { speaker } : {}),
    startMs,
    endMs,
    revision: 0,
  };

  return { kind: 'utterance', utterance };
}
