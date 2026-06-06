import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setItemForTeamAction = vi.fn();
vi.mock('../../app/(authed)/sources/team-source-toggle-action', () => ({
  setItemForTeamAction: (...a: unknown[]) => setItemForTeamAction(...a),
}));

import { SourceItemList, type SourceItem } from '../../app/(authed)/sources/_source-item-list';

const ITEMS: SourceItem[] = [
  { key: 's1', externalId: 'acme/web', label: 'acme/web', count: 240, total: null, status: 'idle' },
  { key: 's2', externalId: 'acme/api', label: 'acme/api', count: 812, total: 1270, status: 'indexing' },
  { key: 's3', externalId: 'acme/mobile', label: 'acme/mobile', count: null, total: null, status: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  setItemForTeamAction.mockResolvedValue({ ok: true });
});

describe('SourceItemList (U3)', () => {
  it('checks an item iff its externalId is in the selected set', () => {
    render(
      <SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set(['acme/web'])} />,
    );
    expect(screen.getByRole('checkbox', { name: /acme\/web for team/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /acme\/api for team/i })).not.toBeChecked();
  });

  it('filters visible rows by label substring', async () => {
    render(<SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set()} />);
    await userEvent.type(screen.getByPlaceholderText('Filter'), 'mobile');
    expect(screen.getByText('acme/mobile')).toBeInTheDocument();
    expect(screen.queryByText('acme/web')).not.toBeInTheDocument();
  });

  it('the Selected tab shows only checked items', async () => {
    render(
      <SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set(['acme/web'])} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Selected$/ }));
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
  });

  it('reports the "N of M selected" count', () => {
    render(
      <SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set(['acme/web'])} />,
    );
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
  });

  it('shows a per-item file count for an idle item', () => {
    render(<SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set()} />);
    expect(screen.getByText('240 files')).toBeInTheDocument();
  });

  it('calls the toggle action with on:true when an unchecked item is checked', async () => {
    render(<SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set()} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /acme\/api for team/i }));
    await waitFor(() =>
      expect(setItemForTeamAction).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 't1', externalId: 'acme/api', on: true }),
      ),
    );
  });

  it('reverts the checkbox + shows an error when the action fails', async () => {
    setItemForTeamAction.mockResolvedValue({ ok: false, error: 'source_not_found' });
    render(<SourceItemList provider="github" teamId="t1" items={ITEMS} selectedKeys={new Set()} />);
    const cb = screen.getByRole('checkbox', { name: /acme\/api for team/i });
    await userEvent.click(cb);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(cb).not.toBeChecked();
  });
});
