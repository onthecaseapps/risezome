import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GapsClient } from '../app/(authed)/gaps/_client';
import type { AssignedQuestionView, GapView } from '../app/(authed)/gaps/_types';

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
