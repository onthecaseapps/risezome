import { describe, it, expect } from 'vitest';
import { summaryLine, type CaptureCard } from '../app/(authed)/captures/_client';

function card(over: Partial<CaptureCard>): CaptureCard {
  return {
    meetingId: 'm',
    title: 'Standup',
    status: 'completed',
    startedAtIso: null,
    endedAtIso: null,
    createdAtIso: '2026-06-05T00:00:00Z',
    platform: 'other',
    summary: null,
    recapAvailable: false,
    recapStatus: 'done',
    answersCount: 0,
    sourcesCount: 0,
    speakers: [],
    errorCode: null,
    errorMessage: null,
    ...over,
  };
}

describe('summaryLine (captures preview, RECAP_PREVIEW_LIMIT + recapAvailable)', () => {
  it('shows the decrypted overview/first line when a summary is present', () => {
    expect(summaryLine(card({ summary: 'We chose the AI stack.' }))).toBe('We chose the AI stack.');
  });

  it('shows the generating state', () => {
    expect(summaryLine(card({ recapStatus: 'generating' }))).toMatch(/generating/i);
  });

  it('shows "Recap available" for a done recap beyond the preview window (exists, not decrypted)', () => {
    expect(summaryLine(card({ recapStatus: 'done', recapAvailable: true, summary: null }))).toMatch(
      /recap available — open to view/i,
    );
  });

  it('shows "No recap" when no recap exists OR a within-window decrypt failed (recapAvailable false)', () => {
    expect(summaryLine(card({ recapStatus: 'done', recapAvailable: false, summary: null }))).toMatch(
      /no recap was generated/i,
    );
  });

  it('surfaces the failure message for a failed meeting', () => {
    expect(summaryLine(card({ status: 'failed', errorMessage: 'bot never admitted' }))).toBe(
      'bot never admitted',
    );
  });
});
