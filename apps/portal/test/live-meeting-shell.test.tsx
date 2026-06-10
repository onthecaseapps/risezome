import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { TranscriptUtterance } from '@risezome/hud-ui';

// The live client mounts the realtime hook (Supabase) + server actions; stub
// them so we can render the recording shell and assert the layout + seeding.
vi.mock('../app/(authed)/meetings/[meetingId]/live/card-actions-server', () => ({
  pinCardAction: vi.fn(),
  dismissCardAction: vi.fn(),
}));
vi.mock('../app/(authed)/meetings/[meetingId]/live/synthesis-actions-server', () => ({
  pinSynthesisAction: vi.fn(),
}));
vi.mock('../app/_lib/realtime-meeting-channel', () => ({
  useRealtimeMeetingChannel: () => ({ status: 'subscribed', liveMeetingStatus: 'recording' }),
}));
// RealtimeWrapper uses useRouter for the completed → recap redirect; there is
// no Next router context under test.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { LiveMeetingClient } from '../app/(authed)/meetings/[meetingId]/live/_client';
import type { InitialSynthesis } from '../app/(authed)/meetings/[meetingId]/live/page';

const TRANSCRIPT: TranscriptUtterance[] = [
  { utteranceId: 'a', text: 'how does retrieval work', speaker: 'Alice', isFinal: true, startMs: 1, endMs: 2, revision: 0 },
];

const SYNTHESIS: InitialSynthesis[] = [
  {
    synthesisId: 's1',
    sourceCardIds: [],
    accumulatedText: 'It uses hybrid search.',
    status: 'done',
    traceId: 't1',
    citations: [],
    pinned: false,
    pinnedAt: null,
  },
];

function renderLive(transcript: TranscriptUtterance[], syntheses: InitialSynthesis[]) {
  return render(
    <LiveMeetingClient
      meetingId="m1"
      orgId="o1"
      status="recording"
      title="Standup"
      errorCode={null}
      errorMessage={null}
      startedAtIso={null}
      initialCards={[]}
      initialSyntheses={syntheses}
      initialTranscript={transcript}
    />,
  );
}

describe('LiveMeetingClient recording shell (U5)', () => {
  it('seeds the prior transcript on first render (no live events)', () => {
    const { getByText, container } = renderLive(TRANSCRIPT, []);
    expect(getByText('how does retrieval work')).toBeInTheDocument();
    expect(getByText('Alice')).toBeInTheDocument();
    expect(container.querySelector('.transcript')).not.toBeNull();
  });

  it('renders transcript (left) and the AI Summary feed (right) together — KTD4', () => {
    const { getByText } = renderLive(TRANSCRIPT, SYNTHESIS);
    // Transcript content (left column).
    expect(getByText('how does retrieval work')).toBeInTheDocument();
    // Synthesis content still renders unchanged (right column).
    expect(getByText(/hybrid search/i)).toBeInTheDocument();
  });

  it('shows the transcript idle state when nothing has been said yet', () => {
    const { getByText } = renderLive([], []);
    expect(getByText(/waiting for the conversation/i)).toBeInTheDocument();
  });
});
