import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The selector writes the global team-lens cookie (switchTeam) then replaces +
// refreshes so the page reads the cookie. Stub the router + the server action.
const replace = vi.fn();
const refresh = vi.fn();
const switchTeam = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));
vi.mock('../../app/(authed)/_components/switch-team-action', () => ({
  switchTeam: (...a: unknown[]) => switchTeam(...a),
}));

import { ConfigTeamSelector } from '../../app/(authed)/sources/_config-team-selector';

const TEAMS = [
  { id: 't1', name: 'Platform' },
  { id: 't2', name: 'Growth' },
];

beforeEach(() => vi.clearAllMocks());

describe('ConfigTeamSelector (U1)', () => {
  it('shows the selected team name in the "Configuring" pill', () => {
    render(<ConfigTeamSelector teams={TEAMS} selectedTeamId="t2" />);
    expect(screen.getByText('Configuring')).toBeInTheDocument();
    expect(screen.getByText('Growth')).toBeInTheDocument();
  });

  it('lists all teams and marks the selected one', async () => {
    render(<ConfigTeamSelector teams={TEAMS} selectedTeamId="t1" />);
    await userEvent.click(screen.getByRole('button', { name: /configuring/i }));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(screen.getByRole('option', { name: /Platform/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Growth/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('writes the team-lens cookie + drops ?team= when a different team is chosen', async () => {
    switchTeam.mockResolvedValue(undefined);
    render(<ConfigTeamSelector teams={TEAMS} selectedTeamId="t1" />);
    await userEvent.click(screen.getByRole('button', { name: /configuring/i }));
    await userEvent.click(screen.getByRole('option', { name: /Growth/ }));
    // Sets the global lens cookie (top-bar follows) for the chosen team…
    expect(switchTeam).toHaveBeenCalledTimes(1);
    const fd = switchTeam.mock.calls[0]![0] as FormData;
    expect(fd.get('teamId')).toBe('t2');
    // …then drops any ?team= override and re-renders off the cookie.
    expect(replace).toHaveBeenCalledWith('/sources');
    expect(refresh).toHaveBeenCalled();
  });

  it('does nothing when the already-selected team is chosen', async () => {
    render(<ConfigTeamSelector teams={TEAMS} selectedTeamId="t1" />);
    await userEvent.click(screen.getByRole('button', { name: /configuring/i }));
    await userEvent.click(screen.getByRole('option', { name: /Platform/ }));
    expect(switchTeam).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
