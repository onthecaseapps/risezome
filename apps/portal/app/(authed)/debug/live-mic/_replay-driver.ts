/**
 * Replay cadence math (U3). Pure — the component owns the timer loop + WS sends;
 * this module only computes WHEN each utterance fires. Faithful cadence with a
 * long-idle-gap cap + speed multiplier (KTD4): preserve short inter-utterance
 * gaps (the sub-30s windows that drive cooldown/dedup/two-lane), clamp long
 * silences to `maxGapMs`, and divide every gap by `speed`.
 */
import type { ReplayUtterance } from './_replay-source';

export interface ReplayCadence {
  /** Clamp any inter-utterance gap to at most this (ms) before scaling. */
  readonly maxGapMs: number;
  /** Wall-clock divisor (2 = twice as fast). Values <= 0 are treated as a tiny floor. */
  readonly speed: number;
}

export interface ScheduledUtterance {
  readonly utterance: ReplayUtterance;
  /** Cumulative ms from replay start at which to fire this utterance. */
  readonly offsetMs: number;
}

export const DEFAULT_CADENCE: ReplayCadence = { maxGapMs: 5000, speed: 4 };

/**
 * Build the firing schedule. The first utterance fires at offset 0; each
 * subsequent offset advances by `min(rawGap, maxGapMs) / speed`, where rawGap is
 * the difference of consecutive `startMs`. Input is assumed startMs-ordered
 * (toReplayUtterances / parseTranscriptFile both sort), but negative gaps are
 * clamped to 0 defensively.
 */
export function computeSchedule(
  utterances: readonly ReplayUtterance[],
  cadence: ReplayCadence,
): ScheduledUtterance[] {
  const speed = cadence.speed > 0 ? cadence.speed : 0.01;
  const cap = cadence.maxGapMs >= 0 ? cadence.maxGapMs : 0;
  let offset = 0;
  let prevStart: number | null = null;
  return utterances.map((utterance) => {
    if (prevStart !== null) {
      const rawGap = Math.max(0, utterance.startMs - prevStart);
      offset += Math.min(rawGap, cap) / speed;
    }
    prevStart = utterance.startMs;
    return { utterance, offsetMs: offset };
  });
}

/** Total wall-clock duration of a schedule (ms) — the last utterance's offset. */
export function scheduleDurationMs(schedule: readonly ScheduledUtterance[]): number {
  return schedule.length === 0 ? 0 : schedule[schedule.length - 1]!.offsetMs;
}
