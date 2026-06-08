/**
 * Per-meeting interim-transcript segment tracker — pass 2 of the live
 * transcript UI.
 *
 * ── Wire contract (pass 2) ────────────────────────────────────────────────
 * To let the live page render a speaker's words AS THEY ARE SPOKEN and then
 * morph the interim into its final, the bot-worker streams INTERIM utterances
 * to the meeting channel as TRANSIENT broadcasts:
 *
 *   event:   `transcript.partial_data`
 *   transient: NEVER persisted (broadcastOnly — no meeting_events row, no
 *              encryption-at-rest)
 *   payload: SAME shape as `transcript.data` (utteranceToEventPayload) but with
 *              isFinal: false
 *   utteranceId: a STABLE per-speech id shared with the eventual persisted
 *              `transcript.data` final, so the client upserts-by-id and the
 *              final REPLACES the interim instead of appending a duplicate line.
 *   revision: monotonically INCREASING per speech across the partials actually
 *              sent (the client rejects a stale/equal revision; a final replaces
 *              a partial regardless of revision).
 *
 * ── Why a tracker is needed ───────────────────────────────────────────────
 * The Recall adapter derives `utteranceId = "<participantId>::<startMs>"`, but a
 * partial's `startMs` DRIFTS as Recall refines the utterance, so consecutive
 * partials + the final get DIFFERENT ids and can't be merged. We pin the FIRST
 * partial's id as the stable id for the whole speech, reuse it for every later
 * partial and the final, then clear the segment when the final lands.
 *
 * Throttling: partials can arrive many times per second. We cap broadcasts to
 * one per INTERIM_THROTTLE_MS per speaker (≤4/sec at 250ms). Dropping the
 * intermediate partials is fine — they're transient and the next one supersedes.
 * Revisions only increment for partials we actually send, so the sequence the
 * client sees is monotonic.
 */

/** Throttle window per speaker for interim broadcasts (250ms ⇒ ≤4/sec). */
export const INTERIM_THROTTLE_MS = 250;

export interface Segment {
  /** Stable id for this speech: the first partial's utteranceId. */
  utteranceId: string;
  /** Last revision we BROADCAST (monotonic across sent partials). */
  revision: number;
  /** Wall-clock ms of the last broadcast, for throttling. */
  lastBroadcastAt: number;
}

/** Per-meeting open segments, keyed by participant. Lives on the runtime so
 *  it's per-meeting and torn down with the runtime. */
export type SegmentTracker = Map<string, Segment>;

export function newSegmentTracker(): SegmentTracker {
  return new Map<string, Segment>();
}

/**
 * The participant id portion of an utteranceId (`<participantId>::<startMs>`).
 * Falls back to the whole id when the `::` separator is absent.
 */
export function participantKeyFromUtteranceId(utteranceId: string): string {
  const idx = utteranceId.indexOf('::');
  return idx === -1 ? utteranceId : utteranceId.slice(0, idx);
}

export interface PartialResolution {
  /** Stable id to broadcast under (the first partial's id for this speech). */
  utteranceId: string;
  /** Revision to broadcast (monotonic across sent partials). */
  revision: number;
  /** Whether this partial should actually be broadcast (false ⇒ throttled). */
  shouldBroadcast: boolean;
}

/**
 * Resolve a partial utterance against the tracker.
 *
 * Opens a segment on the first partial (pinning its id as the stable id). On a
 * throttled partial we leave the segment unchanged and return shouldBroadcast:
 * false — so revisions only advance for partials we actually send, keeping the
 * client-visible sequence monotonic. On a partial we DO send, we bump the
 * revision and stamp lastBroadcastAt.
 */
export function resolvePartial(
  tracker: SegmentTracker,
  incomingUtteranceId: string,
  now: number,
): PartialResolution {
  const key = participantKeyFromUtteranceId(incomingUtteranceId);
  const existing = tracker.get(key);

  if (existing === undefined) {
    // First partial for this speech: this id becomes the stable id. Always
    // broadcast (revision 0).
    const seg: Segment = { utteranceId: incomingUtteranceId, revision: 0, lastBroadcastAt: now };
    tracker.set(key, seg);
    return { utteranceId: seg.utteranceId, revision: 0, shouldBroadcast: true };
  }

  // Throttle: skip if we broadcast too recently. Leave revision untouched.
  if (now - existing.lastBroadcastAt < INTERIM_THROTTLE_MS) {
    return { utteranceId: existing.utteranceId, revision: existing.revision, shouldBroadcast: false };
  }

  // Reuse the stable id (ignore the drifted incoming id); bump revision; send.
  existing.revision += 1;
  existing.lastBroadcastAt = now;
  return { utteranceId: existing.utteranceId, revision: existing.revision, shouldBroadcast: true };
}

export interface FinalResolution {
  /** Stable id the final should land on (overrides the adapter's id when a
   *  segment is open, so it replaces the partials' line). */
  utteranceId: string;
  /** Revision for the final — strictly greater than the segment's last. */
  revision: number;
}

/**
 * Resolve a final utterance against the tracker. If the participant has an open
 * segment, override the final's id with the stable id and give it a revision
 * strictly greater than the segment's last, then CLEAR the segment. If no open
 * segment, keep the adapter's id (revision 0) — no regression for finals that
 * arrive with no preceding partial.
 */
export function resolveFinal(
  tracker: SegmentTracker,
  incomingUtteranceId: string,
): FinalResolution {
  const key = participantKeyFromUtteranceId(incomingUtteranceId);
  const existing = tracker.get(key);
  if (existing === undefined) {
    return { utteranceId: incomingUtteranceId, revision: 0 };
  }
  const resolution: FinalResolution = {
    utteranceId: existing.utteranceId,
    revision: existing.revision + 1,
  };
  tracker.delete(key);
  return resolution;
}
