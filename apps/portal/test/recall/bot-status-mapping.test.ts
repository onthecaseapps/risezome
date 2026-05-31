import { describe, expect, it } from 'vitest';
import {
  diagnosticForSubCode,
  statusForEvent,
} from '../../app/_lib/bot-status-mapping';

describe('statusForEvent', () => {
  it('maps lifecycle events to internal status', () => {
    expect(statusForEvent('bot.joining_call')).toBe('joining');
    expect(statusForEvent('bot.in_waiting_room')).toBe('waiting_room');
    expect(statusForEvent('bot.in_call_recording')).toBe('recording');
    expect(statusForEvent('bot.in_call_not_recording')).toBe('recording');
    expect(statusForEvent('bot.call_ended')).toBe('completed');
    expect(statusForEvent('bot.recording_permission_denied')).toBe('failed');
    expect(statusForEvent('bot.fatal')).toBe('failed');
  });

  it('returns null for events that should be ignored at the DB layer', () => {
    expect(statusForEvent('bot.done')).toBeNull();
    expect(statusForEvent('bot.unknown_future_event')).toBeNull();
    expect(statusForEvent('bot.created')).toBeNull();
  });
});

describe('diagnosticForSubCode', () => {
  it('maps known sub-codes to friendly messages', () => {
    expect(diagnosticForSubCode('recording_permission_denied').message).toMatch(/host declined/i);
    expect(diagnosticForSubCode('meeting_not_found').message).toMatch(/couldn't find/i);
    expect(diagnosticForSubCode('microsoft_teams_recording_disabled').message).toMatch(/IT policy/);
    expect(diagnosticForSubCode('zoom_internal_error').message).toMatch(/Zoom/);
    expect(diagnosticForSubCode('waiting_room_timeout_exceeded').message).toMatch(/lobby/i);
  });

  it('normalizes case so RECALL_INTERNAL_ERROR === recall_internal_error', () => {
    const upper = diagnosticForSubCode('RECORDING_PERMISSION_DENIED');
    const lower = diagnosticForSubCode('recording_permission_denied');
    expect(upper.code).toBe(lower.code);
    expect(upper.message).toBe(lower.message);
  });

  it('falls back to a generic message + raw code for unknown sub-codes', () => {
    const out = diagnosticForSubCode('something_new_recall_added_yesterday');
    expect(out.code).toBe('something_new_recall_added_yesterday');
    expect(out.message).toMatch(/something_new_recall_added_yesterday/);
  });

  it('handles missing sub-code by using "unknown"', () => {
    const out = diagnosticForSubCode(undefined);
    expect(out.code).toBe('unknown');
  });
});
