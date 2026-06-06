import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The selector navigates via next/navigation's router.push; stub it.
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
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

  it('navigates with ?team=<id> when a different team is chosen', async () => {
    render(<ConfigTeamSelector teams={TEAMS} selectedTeamId="t1" />);
    await userEvent.click(screen.getByRole('button', { name: /configuring/i }));
    await userEvent.click(screen.getByRole('option', { name: /Growth/ }));
    expect(push).toHaveBeenCalledWith('/sources?team=t2');
  });

  it('does not navigate when the already-selected team is chosen', async () => {
    render(<ConfigTeamSelector teams={TEAMS} selectedTeamId="t1" />);
    await userEvent.click(screen.getByRole('button', { name: /configuring/i }));
    await userEvent.click(screen.getByRole('option', { name: /Platform/ }));
    expect(push).not.toHaveBeenCalled();
  });
});
