import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The client posts to 'use server' actions whose modules import next/headers
// (illegal in jsdom). Stub every action module the unit imports so the test
// exercises the component's wiring (right action, right args) + optimistic state.
const changeRoleAction = vi.fn();
const removeMemberAction = vi.fn();
vi.mock('../../app/(authed)/members/member-actions', () => ({
  changeRoleAction: (...a: unknown[]) => changeRoleAction(...a),
  removeMemberAction: (...a: unknown[]) => removeMemberAction(...a),
  setCanInviteBotAction: vi.fn(),
}));

const createInviteAction = vi.fn();
const revokeInviteAction = vi.fn();
vi.mock('../../app/(authed)/members/invite-action', () => ({
  createInviteAction: (...a: unknown[]) => createInviteAction(...a),
  revokeInviteAction: (...a: unknown[]) => revokeInviteAction(...a),
}));

const createTeamAction = vi.fn();
const renameTeamAction = vi.fn();
const archiveTeamAction = vi.fn();
const addTeamMemberAction = vi.fn();
const removeTeamMemberAction = vi.fn();
vi.mock('../../app/(authed)/settings/teams/team-actions', () => ({
  createTeamAction: (...a: unknown[]) => createTeamAction(...a),
  renameTeamAction: (...a: unknown[]) => renameTeamAction(...a),
  archiveTeamAction: (...a: unknown[]) => archiveTeamAction(...a),
  addTeamMemberAction: (...a: unknown[]) => addTeamMemberAction(...a),
  removeTeamMemberAction: (...a: unknown[]) => removeTeamMemberAction(...a),
}));

import {
  TeamsMembersClient,
  type MemberVM,
  type TeamVM,
} from '../../app/(authed)/settings/teams/_components/teams-members-client';

const MEMBERS: MemberVM[] = [
  {
    userId: 'u1',
    email: 'alice@acme.com',
    name: 'Alice',
    role: 'super_admin',
    canInviteBot: true,
    isSelf: true,
    lastSignInAt: null,
    teamIds: ['t1'],
  },
  {
    userId: 'u2',
    email: 'bob@acme.com',
    name: 'Bob',
    role: 'member',
    canInviteBot: false,
    isSelf: false,
    lastSignInAt: new Date('2026-01-01').toISOString(),
    teamIds: [],
  },
];

const TEAMS: TeamVM[] = [
  { teamId: 't1', name: 'Platform', slug: 'platform', memberIds: ['u1'], sourceIds: ['s1'] },
];

function renderClient(over?: { isSuperAdmin?: boolean }) {
  return render(
    <TeamsMembersClient
      orgName="Acme"
      members={MEMBERS}
      teams={TEAMS}
      invites={[]}
      isSuperAdmin={over?.isSuperAdmin ?? true}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  changeRoleAction.mockResolvedValue({ ok: true });
  removeMemberAction.mockResolvedValue({ ok: true });
  createInviteAction.mockResolvedValue({ ok: true, url: 'https://risezome.app/invite/abc' });
  addTeamMemberAction.mockResolvedValue({ ok: true });
  removeTeamMemberAction.mockResolvedValue({ ok: true });
  // jsdom has no real clipboard; stub it so copy paths don't throw.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('TeamsMembersClient — All-members view', () => {
  it('shows the page title, org name, and the rail member count', () => {
    renderClient();
    expect(screen.getByRole('heading', { name: /Teams & members/i })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    // "All members" rail entry + count badge (2 members).
    expect(screen.getByText('All members')).toBeInTheDocument();
  });

  it('changing a non-self member role calls changeRoleAction(userId, role)', async () => {
    renderClient();
    const bobRow = screen.getByText('bob@acme.com').closest('li')!;
    const select = within(bobRow).getByRole('combobox');
    await userEvent.selectOptions(select, 'manager');
    await waitFor(() => expect(changeRoleAction).toHaveBeenCalledWith('u2', 'manager'));
  });

  it('hides the Super Admin option from a non-super-admin caller', () => {
    renderClient({ isSuperAdmin: false });
    const bobRow = screen.getByText('bob@acme.com').closest('li')!;
    const select = within(bobRow).getByRole('combobox');
    expect(within(select).queryByRole('option', { name: 'Super Admin' })).toBeNull();
  });

  it('filters members by the search box', async () => {
    renderClient();
    await userEvent.type(screen.getByPlaceholderText('Search members'), 'bob');
    expect(screen.queryByText('alice@acme.com')).toBeNull();
    expect(screen.getByText('bob@acme.com')).toBeInTheDocument();
  });
});

/** Click the rail's team entry. The rail button is the one carrying the "#slug"
 *  (the per-member team pill in the roster has no slug), so it disambiguates the
 *  duplicate "Platform" label. */
async function openTeamDetail(): Promise<void> {
  await userEvent.click(screen.getByText('#platform').closest('button')!);
}

describe('TeamsMembersClient — team detail', () => {
  it('selecting a team in the rail shows its detail with the slug', async () => {
    renderClient();
    await openTeamDetail();
    expect(screen.getByRole('heading', { name: 'Platform' })).toBeInTheDocument();
  });

  it('removing a team member calls removeTeamMemberAction(teamId, userId)', async () => {
    renderClient();
    await openTeamDetail();
    // Alice (u1) is the lone team member; remove her.
    await userEvent.click(screen.getByRole('button', { name: /Remove alice@acme.com from team/i }));
    await waitFor(() => expect(removeTeamMemberAction).toHaveBeenCalledWith('t1', 'u1'));
  });

  it('adding via the picker calls addTeamMemberAction(teamId, userId)', async () => {
    renderClient();
    await openTeamDetail();
    await userEvent.click(screen.getByRole('button', { name: /Add member/i }));
    // Bob (u2) is not on the team → appears as a candidate.
    const picker = screen.getByPlaceholderText('Search workspace members').closest('div')!.parentElement!;
    await userEvent.click(within(picker).getByText('bob@acme.com').closest('li')!.querySelector('button')!);
    await waitFor(() => expect(addTeamMemberAction).toHaveBeenCalledWith('t1', 'u2'));
  });

  it('renders a read-only Sources summary that links to /sources?team=<id> (U6)', async () => {
    renderClient();
    await openTeamDetail();
    // Read-only: a count heading + a "Manage on Sources" link, and NO source
    // toggle switches.
    expect(screen.getByRole('heading', { name: /Sources · 1/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage on Sources/i })).toHaveAttribute(
      'href',
      '/sources?team=t1',
    );
    // No "<source> on team" switches remain in the team detail.
    expect(screen.queryByRole('switch', { name: /on team/i })).toBeNull();
  });
});

describe('TeamsMembersClient — invite modal', () => {
  it('Generate & copy posts the chosen role + team to createInviteAction', async () => {
    renderClient();
    await userEvent.click(screen.getByRole('button', { name: /Invite people/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByPlaceholderText('e.g. Priya'), 'Priya');
    // Two selects: [0] Role, [1] Add to team. Pick the Platform team.
    const selects = within(dialog).getAllByRole('combobox');
    await userEvent.selectOptions(selects[1]!, 't1');
    await userEvent.click(within(dialog).getByRole('button', { name: /Generate & copy/i }));
    await waitFor(() => expect(createInviteAction).toHaveBeenCalled());
    const fd = createInviteAction.mock.calls[0]![0] as FormData;
    expect(fd.get('name')).toBe('Priya');
    expect(fd.get('team_id')).toBe('t1');
  });
});
