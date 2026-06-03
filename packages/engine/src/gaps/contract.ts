/**
 * Knowledge Gaps — shared contract types (plan U3/U4/U5).
 *
 * A "miss" is a question the copilot attempted to answer in a meeting but
 * couldn't ground. The bot-worker records misses live; the post-meeting
 * assembly job dedups them into gaps.
 */

/** Why synthesis couldn't ground an answer (the three capture branches). */
export type MissReason = 'no_hits' | 'refusal' | 'ungrounded';

/**
 * One captured miss, as shaped by the bot-worker and written to
 * `meeting_gap_misses`. `askerName` is resolved later (during assembly) from
 * the transcript event matching `utteranceId`, so it is not required here.
 */
export interface MissRecord {
  readonly verbatimQuestion: string;
  readonly utteranceId: string;
  readonly meetingId: string;
  readonly orgId: string;
  readonly reason: MissReason;
  readonly sourcesSearched?: readonly string[];
  readonly intent?: string;
  readonly entities?: readonly string[];
}
