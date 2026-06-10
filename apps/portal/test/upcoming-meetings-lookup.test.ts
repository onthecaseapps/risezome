import { describe, it, expect } from 'vitest';
import {
  preferMeetingRow,
  type MeetingRow,
  type MeetingStatus,
} from '../app/(authed)/upcoming/_meetings-lookup';

function row(status: MeetingStatus, meetingId: string): MeetingRow {
  return {
    meeting_id: meetingId,
    calendar_event_id: 'event-1',
    status,
    error_message: null,
    started_at: null,
  };
}

describe('preferMeetingRow (F6 — two non-failed rows for one event)', () => {
  it('takes the candidate when there is no current row', () => {
    expect(preferMeetingRow(undefined, row('completed', 'm1'))).toEqual(row('completed', 'm1'));
  });

  it('an active relaunch beats an earlier completed row (completed first in created_at order)', () => {
    const completed = row('completed', 'm-old');
    const relaunch = row('launching', 'm-new');
    expect(preferMeetingRow(completed, relaunch)).toEqual(relaunch);
  });

  it('an active row is kept even when a completed row arrives after it', () => {
    // Defensive: explicit status priority, not just write order — if the
    // completed row happens to sort later, the active one must still win.
    const recording = row('recording', 'm-live');
    const completed = row('completed', 'm-done');
    expect(preferMeetingRow(recording, completed)).toEqual(recording);
  });

  it('within the same tier the candidate (newer created_at) wins', () => {
    expect(preferMeetingRow(row('completed', 'm-old'), row('completed', 'm-new')).meeting_id).toBe(
      'm-new',
    );
    expect(preferMeetingRow(row('joining', 'm-old'), row('recording', 'm-new')).meeting_id).toBe(
      'm-new',
    );
  });
});
