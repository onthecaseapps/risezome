import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The pickers post to 'use server' actions whose modules import next/headers
// (illegal in jsdom). Stub the action modules so the unit under test is the
// component's call (right action, right args) + optimistic/revert behavior.
const addTeamMemberAction = vi.fn();
const removeTeamMemberAction = vi.fn();
vi.mock('../../app/(authed)/teams/team-actions', () => ({
  addTeamMemberAction: (...a: unknown[]) => addTeamMemberAction(...a),
  removeTeamMemberAction: (...a: unknown[]) => removeTeamMemberAction(...a),
  // unused by these tests but exported by the real module:
  createTeamAction: vi.fn(),
  renameTeamAction: vi.fn(),
  archiveTeamAction: vi.fn(),
}));

const addTeamSourceAction = vi.fn();
const removeTeamSourceAction = vi.fn();
vi.mock('../../app/(authed)/teams/source-actions', () => ({
  addTeamSourceAction: (...a: unknown[]) => addTeamSourceAction(...a),
  removeTeamSourceAction: (...a: unknown[]) => removeTeamSourceAction(...a),
}));

import { MemberPicker } from '../../app/(authed)/teams/_components/member-picker';
import { SourcePicker } from '../../app/(authed)/teams/_components/source-picker';
import type { OrgMember, TeamSourceRow } from '../../app/(authed)/teams/_components/teams-client';

const MEMBERS: OrgMember[] = [
  { userId: 'u1', email: 'alice@acme.com', name: 'Alice', role: 'super_admin', isSelf: true },
  { userId: 'u2', email: 'bob@acme.com', name: 'Bob', role: 'member', isSelf: false },
];

const SOURCES: TeamSourceRow[] = [
  { id: 's1', kind: 'github', label: 'acme/api' },
  { id: 's2', kind: 'trello', label: 'Roadmap' },
];

beforeEach(() => {
  vi.clearAllMocks();
  addTeamMemberAction.mockResolvedValue({ ok: true });
  removeTeamMemberAction.mockResolvedValue({ ok: true });
  addTeamSourceAction.mockResolvedValue({ ok: true });
  removeTeamSourceAction.mockResolvedValue({ ok: true });
});

describe('MemberPicker (U7)', () => {
  it('toggling an off member calls addTeamMemberAction(teamId, userId)', async () => {
    render(
      <MemberPicker
        teamId="t1"
        members={MEMBERS}
        initialMemberIds={['u1']}
        roleLabelFn={(r) => r}
      />,
    );
    // Bob (u2) is off → toggling adds.
    await userEvent.click(screen.getByRole('switch', { name: 'bob@acme.com on team' }));
    await waitFor(() => expect(addTeamMemberAction).toHaveBeenCalledWith('t1', 'u2'));
    expect(removeTeamMemberAction).not.toHaveBeenCalled();
  });

  it('toggling an on member calls removeTeamMemberAction(teamId, userId)', async () => {
    render(
      <MemberPicker teamId="t1" members={MEMBERS} initialMemberIds={['u1']} roleLabelFn={(r) => r} />,
    );
    // Alice (u1) is on → toggling removes.
    await userEvent.click(screen.getByRole('switch', { name: 'alice@acme.com on team' }));
    await waitFor(() => expect(removeTeamMemberAction).toHaveBeenCalledWith('t1', 'u1'));
  });

  it('reverts the toggle + shows an error when the action fails', async () => {
    addTeamMemberAction.mockResolvedValue({ ok: false, error: 'not_an_org_member' });
    render(
      <MemberPicker teamId="t1" members={MEMBERS} initialMemberIds={[]} roleLabelFn={(r) => r} />,
    );
    const sw = screen.getByRole('switch', { name: 'bob@acme.com on team' });
    await userEvent.click(sw);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not a member/i));
    // Reverted back to off.
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

describe('SourcePicker (U7)', () => {
  it('toggling an off source calls addTeamSourceAction(teamId, sourceId)', async () => {
    render(<SourcePicker teamId="t1" sources={SOURCES} initialSourceIds={['s1']} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Roadmap on team' }));
    await waitFor(() => expect(addTeamSourceAction).toHaveBeenCalledWith('t1', 's2'));
    expect(removeTeamSourceAction).not.toHaveBeenCalled();
  });

  it('toggling an on source calls removeTeamSourceAction(teamId, sourceId)', async () => {
    render(<SourcePicker teamId="t1" sources={SOURCES} initialSourceIds={['s1']} />);
    await userEvent.click(screen.getByRole('switch', { name: 'acme/api on team' }));
    await waitFor(() => expect(removeTeamSourceAction).toHaveBeenCalledWith('t1', 's1'));
  });

  it('renders an empty state with a link to /sources when no sources exist', () => {
    render(<SourcePicker teamId="t1" sources={[]} initialSourceIds={[]} />);
    expect(screen.getByRole('link', { name: /sources/i })).toHaveAttribute('href', '/sources');
  });
});
