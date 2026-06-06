import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';

const setItemForTeamAction = vi.fn();
vi.mock('../../app/(authed)/sources/team-source-toggle-action', () => ({
  setItemForTeamAction: (...a: unknown[]) => setItemForTeamAction(...a),
}));

const reindexSourceAction = vi.fn();
vi.mock('../../app/(authed)/sources/reindex-action', () => ({
  reindexSourceAction: (...a: unknown[]) => reindexSourceAction(...a),
}));

import { ConnectionCard, type ConnectionCardData } from '../../app/(authed)/sources/_connection-card';
import type { SourceItem } from '../../app/(authed)/sources/_source-item-list';

function ghItems(): SourceItem[] {
  return [
    { key: 's1', sourceId: 's1', externalId: 'acme/web', label: 'acme/web', count: 240, total: null, status: 'idle', installationId: 1 },
    { key: 's2', sourceId: 's2', externalId: 'acme/api', label: 'acme/api', count: 812, total: 1270, status: 'indexing', installationId: 1 },
  ];
}

function card(over: Partial<ConnectionCardData> = {}): ConnectionCardData {
  return {
    provider: 'github',
    cardKey: 'gh-1',
    name: 'GitHub',
    badge: 'acme',
    icon: createElement('span', null, 'gh'),
    manageUrl: 'https://github.com/x',
    items: ghItems(),
    selectedExternalIds: ['acme/web'],
    installationId: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setItemForTeamAction.mockResolvedValue({ ok: true });
  reindexSourceAction.mockResolvedValue({ ok: true });
});

describe('ConnectionCard (U2)', () => {
  it('renders the connection name + account badge', () => {
    render(<ConnectionCard teamId="t1" data={card()} />);
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
  });

  it('shows a suspended status line when the installation is suspended', () => {
    render(<ConnectionCard teamId="t1" data={card({ suspended: true })} />);
    expect(screen.getByText(/Suspended/i)).toBeInTheDocument();
  });

  it('keeps the item checklist collapsed until expanded', async () => {
    render(<ConnectionCard teamId="t1" data={card()} />);
    expect(screen.queryByRole('checkbox', { name: /acme\/web for team/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByRole('checkbox', { name: /acme\/web for team/i })).toBeInTheDocument();
  });

  it('master toggle reflects partial selection (1 of 2 selected → not all-checked)', () => {
    render(<ConnectionCard teamId="t1" data={card()} />);
    const master = screen.getByRole('switch', { name: /select all items/i });
    expect(master).toHaveAttribute('aria-checked', 'false');
  });

  it('master toggle adds the unselected items when turned on', async () => {
    render(<ConnectionCard teamId="t1" data={card()} />);
    await userEvent.click(screen.getByRole('switch', { name: /select all items/i }));
    // Only acme/api was unselected → exactly one add call, with on: true.
    expect(setItemForTeamAction).toHaveBeenCalledTimes(1);
    expect(setItemForTeamAction).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'acme/api', on: true, provider: 'github' }),
    );
  });

  it('exposes the provider manage link in the kebab menu', async () => {
    render(<ConnectionCard teamId="t1" data={card()} />);
    await userEvent.click(screen.getByRole('button', { name: /connection actions/i }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Manage on GitHub/i })).toHaveAttribute(
      'href',
      'https://github.com/x',
    );
  });

  it('offers Reindex (delta/full) in the kebab and reindexes every source of the connection', async () => {
    render(<ConnectionCard teamId="t1" data={card()} />);
    await userEvent.click(screen.getByRole('button', { name: /connection actions/i }));
    const menu = screen.getByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Reindex \(delta\)/i })).toBeInTheDocument();
    const full = within(menu).getByRole('menuitem', { name: /Reindex \(full\)/i });
    expect(full).toBeInTheDocument();

    await userEvent.click(full);

    // One reindexSourceAction call per source row (s1, s2), all with mode=full.
    expect(reindexSourceAction).toHaveBeenCalledTimes(2);
    const sentSourceIds = reindexSourceAction.mock.calls.map((c) => {
      const fd = c[0] as FormData;
      return { sourceId: fd.get('sourceId'), mode: fd.get('mode') };
    });
    expect(sentSourceIds).toEqual(
      expect.arrayContaining([
        { sourceId: 's1', mode: 'full' },
        { sourceId: 's2', mode: 'full' },
      ]),
    );
  });

  it('omits Reindex when no item has a source row (available-but-unindexed only)', async () => {
    const noSources = ghItems().map(({ sourceId: _drop, ...rest }) => rest);
    render(<ConnectionCard teamId="t1" data={card({ items: noSources })} />);
    await userEvent.click(screen.getByRole('button', { name: /connection actions/i }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /Reindex/i })).not.toBeInTheDocument();
  });
});
