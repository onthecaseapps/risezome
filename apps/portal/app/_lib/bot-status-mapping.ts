/**
 * Translates Recall.ai bot status sub-codes into:
 *   1. An internal meetings.status enum value
 *   2. A user-facing error message + next-action hint (R26)
 *
 * Sub-codes per Recall.ai's docs:
 *   - recording_permission_denied   — host declined the recording prompt
 *   - meeting_link_invalid          — bad URL
 *   - meeting_not_found             — URL doesn't resolve / meeting deleted
 *   - meeting_password_incorrect    — wrong password in URL
 *   - meeting_locked                — meeting locked by host
 *   - waiting_room_timeout_exceeded — host never admitted us
 *   - microsoft_teams_captcha_detected   — Teams flagged the bot
 *   - microsoft_teams_recording_disabled — IT policy blocks bots
 *   - zoom_internal_error           — Zoom returned an error
 *   - bot_kicked                    — host removed the bot
 *   - timed_out                     — bot was idle too long
 *   - unknown                       — fallthrough
 *
 * Recall keeps adding sub-codes; the fallback returns a generic message
 * with the raw code so an operator can debug. Add new mappings here as
 * we encounter them in production.
 */

/**
 * The full meeting status enum, matching the CHECK constraint on
 * meetings.status in supabase/migrations/20260601300000_meetings.sql.
 * The live page's narrower MeetingStatus excludes 'completed' (because
 * the page redirects on that value); webhooks need the full set.
 */
export type DbMeetingStatus =
  | 'launching'
  | 'awaiting_recall'
  | 'joining'
  | 'waiting_room'
  | 'recording'
  | 'completed'
  | 'failed';

/**
 * Status-only mapping for normal lifecycle events.
 *
 * Map of Recall event_type → meeting status. Returns null when the
 * event should be ignored (e.g. bot.done, which is Recall's "we're
 * done processing" signal — doesn't change user-visible state).
 */
export function statusForEvent(eventType: string): DbMeetingStatus | null {
  switch (eventType) {
    case 'bot.joining_call':
      return 'joining';
    case 'bot.in_waiting_room':
      return 'waiting_room';
    case 'bot.in_call_recording':
    case 'bot.in_call_not_recording':
      // in_call_not_recording = bot is in the call but hasn't started
      // recording yet (e.g. permission hasn't been granted). For UI
      // purposes treat as recording-shell-eligible; users see the
      // recording shell with no cards arriving.
      return 'recording';
    case 'bot.call_ended':
      return 'completed';
    case 'bot.recording_permission_denied':
    case 'bot.fatal':
      return 'failed';
    case 'bot.done':
      return null; // signal-only; bot-worker uses this to flush
    default:
      return null;
  }
}

/**
 * For events that may carry a failure sub-code, translate to a
 * user-readable message + next-action hint.
 */
export function diagnosticForSubCode(subCode: string | undefined): {
  code: string;
  message: string;
} {
  const c = (subCode ?? 'unknown').toLowerCase();
  if (c in CODE_MESSAGES) {
    return { code: c, message: CODE_MESSAGES[c]! };
  }
  return {
    code: c,
    message: `Recall.ai reported a problem (${c}). Try toggling the bot off and on; if it persists, the meeting URL may be unreachable.`,
  };
}

const CODE_MESSAGES: Record<string, string> = {
  recording_permission_denied:
    'The meeting host declined the recording prompt. Risezome needs recording permission to take notes.',
  meeting_link_invalid:
    "The meeting URL didn't look right to Zoom/Meet. Double-check the link on the calendar event.",
  meeting_not_found:
    "Recall couldn't find that meeting. Was it deleted, or does the URL include the right meeting ID?",
  meeting_password_incorrect:
    'The meeting password in the URL was rejected. Update the calendar event with the right link.',
  meeting_locked:
    'The meeting is locked by the host. Ask the host to unlock it before Risezome can join.',
  waiting_room_timeout_exceeded:
    "Risezome waited in the lobby but wasn't admitted. Ask the host to let the bot in next time.",
  microsoft_teams_captcha_detected:
    'Teams flagged the bot with a CAPTCHA. Teams support requires your IT admin to whitelist Risezome.',
  microsoft_teams_recording_disabled:
    'Teams IT policy is blocking bots from recording. Have your admin enable bot recording for the tenant.',
  zoom_internal_error:
    'Zoom returned a temporary error. The bot will retry on the next scheduled meeting.',
  bot_kicked:
    'Risezome was removed from the meeting. If this was unintentional, toggle the bot on for the next meeting.',
  timed_out:
    'The bot timed out without recording anything. Either the meeting ended early or nobody joined.',
};
