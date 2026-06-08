import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GapsClient } from '../app/(authed)/gaps/_client';
import { GapDrawer } from '../app/(authed)/gaps/_gap-drawer';
import { GapRow } from '../app/(authed)/gaps/_gap-row';
import type { AssignedQuestionView, GapOccurrenceView, GapView } from '../app/(authed)/gaps/_types';

/**
 * U8 — "Assigned to you" (U5's deferred metadata-only assignee surface).
 *
 * The surface for a NON-attendee assignee who can't open the gap itself: it must
 * render ONLY the question (title), asker_name, recurrence (frequency /
 * last_asked), and status — and NEVER verbatim occurrences or a link through to
 * the gap drawer. Empty list ⇒ render nothing (no noisy empty state).
 */

const baseGap: GapView = {
  gapId: 'g-visible',
  sectionId: null,
  title: 'A gap I can actually open',
  status: 'open',
  assigneeId: null,
  assigneeName: null,
  frequency: 2,
  sharedWithOrg: false,
  sectionPinned: false,
  reopenedAfterClose: false,
  firstAskedAtIso: '2026-05-01T00:00:00.000Z',
  lastAskedAtIso: '2026-05-02T00:00:00.000Z',
  assignedByName: null,
  assignedAtIso: null,
  people: 1,
  meetings: 1,
  moments: 1,
  extraPhrasings: 0,
  canViewContent: true,
  occurrences: [],
};

const assigned: AssignedQuestionView[] = [
  {
    gapId: 'g-assigned-1',
    title: 'What is our refund SLA?',
    askerName: 'Dana Rivera',
    frequency: 5,
    lastAskedAtIso: '2026-05-20T00:00:00.000Z',
    status: 'open',
  },
];

function renderClient(assignedQuestions: AssignedQuestionView[], gaps: GapView[] = [baseGap]) {
  return render(
    <GapsClient
      gaps={gaps}
      sections={[]}
      members={[]}
      isManager={false}
      currentUserId="user-1"
      notifications={[]}
      assignedQuestions={assignedQuestions}
    />,
  );
}

describe('GapsClient — "Assigned to you" (U8)', () => {
  it('renders the question, asker, recurrence, and status as metadata only', () => {
    renderClient(assigned);

    const heading = screen.getByText('Assigned to you');
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    const scoped = within(section as HTMLElement);

    expect(scoped.getByText('What is our refund SLA?')).toBeInTheDocument();
    expect(scoped.getByText(/Asked by Dana Rivera/)).toBeInTheDocument();
    expect(scoped.getByText(/5× asked/)).toBeInTheDocument();
    expect(scoped.getByText(/^Open$/i)).toBeInTheDocument();
  });

  it('does NOT link assigned rows through to the gap drawer / verbatim', () => {
    renderClient(assigned);
    const section = screen.getByText('Assigned to you').closest('section') as HTMLElement;
    const scoped = within(section);
    // No anchors and no buttons inside the read-only list — nothing to open.
    expect(scoped.queryAllByRole('link')).toHaveLength(0);
    expect(scoped.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders nothing when the assigned list is empty (no noisy empty state)', () => {
    renderClient([]);
    expect(screen.queryByText('Assigned to you')).not.toBeInTheDocument();
  });
});

/**
 * CONTENT gate (20260611010000_gap_content_gate) — the drawer + row must hide the
 * room's verbatim (paraphrases + captured moments / "Open moment" deep-link) and
 * the content-derived count pills for a non-content viewer (outsider-assignee or
 * org-wide-share), while still showing the gap ROW (title / status / assignee).
 */
const occurrence: GapOccurrenceView = {
  occurrenceId: 'occ-1',
  meetingId: 'mtg-1',
  utteranceId: 'utt-1',
  verbatimQuestion: 'SECRET VERBATIM: what exactly is the refund SLA?',
  askerName: 'Dana Rivera',
  askerUserId: null,
  askedAtIso: '2026-05-20T00:00:00.000Z',
  meetingTitle: 'Support sync',
};

const contentGap: GapView = {
  ...baseGap,
  gapId: 'g-content',
  title: 'What is our refund SLA?',
  people: 2,
  meetings: 1,
  moments: 1,
  extraPhrasings: 1,
  canViewContent: true,
  occurrences: [occurrence],
};

describe('GapDrawer — CONTENT gate', () => {
  it('shows paraphrases + the "Open moment" link when canViewContent is true', () => {
    render(<GapDrawer gap={contentGap} sections={[]} members={[]} isManager={false} now={Date.now()} onClose={() => {}} />);
    // Appears in both the merged-phrasings block and the moment row.
    expect(screen.getAllByText(/SECRET VERBATIM/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Merged phrasings/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open moment/ });
    expect(link).toHaveAttribute('href', '/meetings/mtg-1/review#utterance-utt-1');
    expect(screen.queryByText(/weren’t in the original meeting/)).not.toBeInTheDocument();
  });

  it('hides paraphrases + the "Open moment" link and shows the note when canViewContent is false', () => {
    // Belt-and-suspenders: even though RLS returns no occurrences for a non-content
    // viewer, we pass one through and assert the verbatim + link still never render.
    const hidden: GapView = { ...contentGap, gapId: 'g-hidden', canViewContent: false };
    render(<GapDrawer gap={hidden} sections={[]} members={[]} isManager={false} now={Date.now()} onClose={() => {}} />);
    expect(screen.getByText(/weren’t in the original meeting/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET VERBATIM/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open moment/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Merged phrasings/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Where it was asked/)).not.toBeInTheDocument();
    // The gap ROW + the resolve control remain available to the assignee.
    expect(screen.getByText('What is our refund SLA?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark resolved/ })).toBeInTheDocument();
  });
});

describe('GapRow — CONTENT gate', () => {
  const rowProps = {
    members: [],
    isManager: false,
    now: Date.parse('2026-05-21T00:00:00.000Z'),
    onOpen: () => {},
    onAssign: () => {},
    onMerge: () => {},
    onMoveSection: () => {},
  };

  it('shows the +N phrasings pill and content meta when canViewContent is true', () => {
    render(<GapRow gap={contentGap} {...rowProps} />);
    expect(screen.getByText(/\+1 phrasings/)).toBeInTheDocument();
    expect(screen.getByText(/moment/)).toBeInTheDocument();
  });

  it('hides the +N phrasings pill and content meta when canViewContent is false', () => {
    const hidden: GapView = { ...contentGap, gapId: 'g-hidden-row', canViewContent: false };
    render(<GapRow gap={hidden} {...rowProps} />);
    expect(screen.queryByText(/phrasings/)).not.toBeInTheDocument();
    expect(screen.queryByText(/moment/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/asked$/)).not.toBeInTheDocument();
    // Title + status remain.
    expect(screen.getByText('What is our refund SLA?')).toBeInTheDocument();
  });
});
