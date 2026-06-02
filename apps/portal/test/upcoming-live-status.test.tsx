import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  LiveStatusProvider,
  LiveStatusChip,
  LiveMeetingCta,
  describeRowStatus,
  type EventTiming,
} from '../app/(authed)/upcoming/_live-status';
import { pollMeetingStatusesAction } from '../app/(authed)/upcoming/poll-status-action';
import type { MeetingRow } from '../app/(authed)/upcoming/_meetings-lookup';

vi.mock('../app/(authed)/upcoming/poll-status-action', () => ({
  pollMeetingStatusesAction: vi.fn(),
}));
const mockedPoll = vi.mocked(pollMeetingStatusesAction);

const TIMING: EventTiming = {
  start_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  end_at: new Date(Date.now() + 90 * 60_000).toISOString(),
  bot_optin: true,
};

function meeting(status: MeetingRow['status'], startedAt: string | null = null): MeetingRow {
  return { meeting_id: 'm1', calendar_event_id: 'e1', status, error_message: null, started_at: startedAt };
}

afterEach(() => {
  vi.useRealTimers();
  mockedPoll.mockReset();
});

describe('describeRowStatus', () => {
  it('bot lifecycle status dominates the time-based label', () => {
    expect(describeRowStatus(TIMING, meeting('joining'))?.label).toMatch(/bot joining/i);
    expect(describeRowStatus(TIMING, meeting('recording', new Date().toISOString()))?.tone).toBe('live');
    expect(describeRowStatus(TIMING, meeting('failed'))?.tone).toBe('failed');
  });

  it('falls back to a scheduled time label when there is no meeting', () => {
    expect(describeRowStatus(TIMING, null)?.label).toMatch(/bot launching in|bot scheduled/i);
  });
});

describe('LiveStatusProvider polling', () => {
  it('advances a row from launching to recording on a poll tick', async () => {
    vi.useFakeTimers();
    mockedPoll.mockResolvedValue({ e1: meeting('recording', new Date().toISOString()) });

    render(
      <LiveStatusProvider eventIds={['e1']} initial={{ e1: meeting('launching') }}>
        <LiveStatusChip event={TIMING} eventId="e1" />
        <LiveMeetingCta eventId="e1" />
      </LiveStatusProvider>,
    );

    // Initial server-seeded state: launching → "Bot joining…", CTA "View meeting".
    expect(screen.getByText(/bot joining/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open meeting/i })).toBeInTheDocument();

    // Poll tick returns recording.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByText(/live now/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open live view/i })).toBeInTheDocument();
  });

  it('only patches the row that changed; unrelated rows keep their state', async () => {
    vi.useFakeTimers();
    mockedPoll.mockResolvedValue({
      e1: meeting('recording', new Date().toISOString()),
      e2: meeting('joining'),
    });

    render(
      <LiveStatusProvider
        eventIds={['e1', 'e2']}
        initial={{ e1: meeting('launching'), e2: meeting('joining') }}
      >
        <LiveStatusChip event={TIMING} eventId="e1" />
        <LiveStatusChip event={TIMING} eventId="e2" />
      </LiveStatusProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByText(/live now/i)).toBeInTheDocument(); // e1 changed
    expect(screen.getByText(/bot joining/i)).toBeInTheDocument(); // e2 unchanged
  });

  it('stops polling after unmount (interval cleared)', async () => {
    vi.useFakeTimers();
    mockedPoll.mockResolvedValue({});

    const { unmount } = render(
      <LiveStatusProvider eventIds={['e1']} initial={{}}>
        <LiveStatusChip event={TIMING} eventId="e1" />
      </LiveStatusProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const callsBefore = mockedPoll.mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(mockedPoll.mock.calls.length).toBe(callsBefore);
  });
});
