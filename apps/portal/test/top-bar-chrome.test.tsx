import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The team switcher + user menu post to 'use server' actions. Those modules pull
// in next/headers (illegal in jsdom), so stub them — the action call itself is
// not the unit under test here (the cookie write has its own server contract).
const switchTeam = vi.fn();
vi.mock('../app/(authed)/_components/switch-team-action', () => ({
  switchTeam: (formData: FormData) => switchTeam(formData),
}));

// The breadcrumb's page segment reads the active route via usePathname.
let mockPathname = '/captures';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

import { TeamSwitcher } from '../app/(authed)/_components/team-switcher';
import { UserAvatarMenu } from '../app/(authed)/_components/user-avatar-menu';

const TEAMS = [
  { id: 't1', name: 'Platform', slug: 'platform' },
  { id: 't2', name: 'Growth', slug: 'growth' },
];

beforeEach(() => {
  mockPathname = '/captures'; // reset the breadcrumb's page route per test
  // jsdom has no matchMedia; the theme-cycle effect reads it. Report "light".
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
        dispatchEvent: (): boolean => false,
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('TeamSwitcher (U6)', () => {
  it('renders a static breadcrumb with no dropdown when the user has NO teams', () => {
    render(<TeamSwitcher orgName="Acme" currentTeamId={null} teams={[]} />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('All meetings')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows the switcher dropdown even with a SINGLE team (My meetings + the team)', () => {
    render(<TeamSwitcher orgName="Acme" currentTeamId="t1" teams={[TEAMS[0]!]} />);
    expect(screen.getByText('#platform')).toBeInTheDocument(); // breadcrumb crumb
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('My meetings')).toBeInTheDocument();
    expect(within(menu).getByText('platform')).toBeInTheDocument(); // the one team is still switchable
  });

  it('renders the current page as a third segment: Org / team / page', () => {
    mockPathname = '/settings/teams';
    render(<TeamSwitcher orgName="Acme" currentTeamId="t1" teams={TEAMS} />);
    expect(screen.getByText('Acme')).toBeInTheDocument(); // org
    expect(screen.getByText('#platform')).toBeInTheDocument(); // team (dropdown trigger)
    expect(screen.getByText('Teams & members')).toBeInTheDocument(); // page
  });

  it('omits the page segment on an unmapped route', () => {
    mockPathname = '/some/unmapped/route';
    render(<TeamSwitcher orgName="Acme" currentTeamId={null} teams={[]} />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('All meetings')).toBeInTheDocument();
    // Only org + team — no third segment for an unknown route.
    expect(screen.queryByText('Captures')).not.toBeInTheDocument();
  });

  it('lists the user teams plus a "My meetings" entry when there are 2+', () => {
    render(<TeamSwitcher orgName="Acme" currentTeamId="t1" teams={TEAMS} />);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('My meetings')).toBeInTheDocument();
    expect(within(menu).getByText('platform')).toBeInTheDocument();
    expect(within(menu).getByText('growth')).toBeInTheDocument();
    // The selected team is marked checked; "My meetings" is not.
    const items = within(menu).getAllByRole('menuitemradio');
    const platform = items.find((el) => el.textContent?.includes('platform'));
    expect(platform).toHaveAttribute('aria-checked', 'true');
  });

  it('posts the chosen team id to the switch action on selection', async () => {
    const user = userEvent.setup();
    render(<TeamSwitcher orgName="Acme" currentTeamId={null} teams={TEAMS} />);
    const menu = screen.getByRole('menu');
    const growthBtn = within(menu)
      .getAllByRole('menuitemradio')
      .find((el) => el.textContent?.includes('growth'))!;
    await user.click(growthBtn);

    expect(switchTeam).toHaveBeenCalledTimes(1);
    const formData = switchTeam.mock.calls[0]![0] as FormData;
    expect(formData.get('teamId')).toBe('t2');
  });

  it('"My meetings" clears the lens via the "all" sentinel', async () => {
    const user = userEvent.setup();
    render(<TeamSwitcher orgName="Acme" currentTeamId="t1" teams={TEAMS} />);
    await user.click(screen.getByRole('menuitemradio', { name: /my meetings/i }));
    const formData = switchTeam.mock.calls[0]![0] as FormData;
    expect(formData.get('teamId')).toBe('all');
  });

  it('closes the open dropdown on an outside pointer-down', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TeamSwitcher orgName="Acme" currentTeamId="t1" teams={TEAMS} />,
    );
    const details = container.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    await user.click(summary);
    expect(details.open).toBe(true);

    await user.click(document.body); // pointer-down outside the switcher
    expect(details.open).toBe(false);
  });

  it('closes the open dropdown on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TeamSwitcher orgName="Acme" currentTeamId="t1" teams={TEAMS} />,
    );
    const details = container.querySelector('details')!;
    await user.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);

    await user.keyboard('{Escape}');
    expect(details.open).toBe(false);
  });
});

describe('UserAvatarMenu (U6)', () => {
  it('renders the account menu items and omits "switch workspace"', () => {
    render(<UserAvatarMenu email="jordan@acme.dev" fullName="Jordan Lee" />);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText(/profile & account/i)).toBeInTheDocument();
    expect(within(menu).getByText(/notification settings/i)).toBeInTheDocument();
    // "What's new" moved here from the sidebar (it's product news, not config).
    expect(within(menu).getByRole('menuitem', { name: /what's new/i })).toHaveAttribute(
      'href',
      '/whats-new',
    );
    expect(within(menu).getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
    // Single-org model: there is no workspace switcher in the user menu.
    expect(within(menu).queryByText(/switch workspace/i)).not.toBeInTheDocument();
  });

  it('shows initials derived from the display name', () => {
    render(<UserAvatarMenu email="jordan@acme.dev" fullName="Jordan Lee" />);
    expect(screen.getAllByText('JL').length).toBeGreaterThan(0);
  });

  it('closes the open account menu on an outside pointer-down', async () => {
    const user = userEvent.setup();
    const { container } = render(<UserAvatarMenu email="jordan@acme.dev" fullName="Jordan Lee" />);
    const details = container.querySelector('details')!;
    await user.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);

    await user.click(document.body);
    expect(details.open).toBe(false);
  });

  it('closes the open account menu on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(<UserAvatarMenu email="jordan@acme.dev" fullName="Jordan Lee" />);
    const details = container.querySelector('details')!;
    await user.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);

    await user.keyboard('{Escape}');
    expect(details.open).toBe(false);
  });
});
