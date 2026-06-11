import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SourceItemList, type SourceItem } from '../../app/(authed)/sources/_source-item-list';

const ITEMS: SourceItem[] = [
  { key: 's1', externalId: 'acme/web', label: 'acme/web', count: 240, total: null, status: 'idle' },
  { key: 's2', externalId: 'acme/api', label: 'acme/api', count: 812, total: 1270, status: 'indexing' },
  { key: 's3', externalId: 'acme/mobile', label: 'acme/mobile', count: null, total: null, status: null },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SourceItemList (U3 — controlled)', () => {
  it('checks an item iff its externalId is in the selected set', () => {
    render(<SourceItemList provider="github" items={ITEMS} selectedKeys={new Set(['acme/web'])} />);
    expect(screen.getByRole('checkbox', { name: /acme\/web for team/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /acme\/api for team/i })).not.toBeChecked();
  });

  it('filters visible rows by label substring', async () => {
    render(<SourceItemList provider="github" items={ITEMS} selectedKeys={new Set()} />);
    await userEvent.type(screen.getByPlaceholderText('Filter'), 'mobile');
    expect(screen.getByText('acme/mobile')).toBeInTheDocument();
    expect(screen.queryByText('acme/web')).not.toBeInTheDocument();
  });

  it('the Selected tab shows only checked items', async () => {
    render(<SourceItemList provider="github" items={ITEMS} selectedKeys={new Set(['acme/web'])} />);
    await userEvent.click(screen.getByRole('button', { name: /^Selected$/ }));
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
  });

  it('reports the "N of M selected" count from selectedKeys', () => {
    render(<SourceItemList provider="github" items={ITEMS} selectedKeys={new Set(['acme/web'])} />);
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
  });

  it('shows a per-item file count for an idle item', () => {
    render(<SourceItemList provider="github" items={ITEMS} selectedKeys={new Set()} />);
    expect(screen.getByText('240 files')).toBeInTheDocument();
  });

  it('toggling an item REPORTS the staged change via onSelectionChange (no immediate action)', async () => {
    const onSelectionChange = vi.fn();
    render(
      <SourceItemList provider="github" items={ITEMS} selectedKeys={new Set()} onSelectionChange={onSelectionChange} />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /acme\/api for team/i }));
    expect(onSelectionChange).toHaveBeenCalledWith('acme/api', true);
  });

  it('unchecking a selected item reports on:false', async () => {
    const onSelectionChange = vi.fn();
    render(
      <SourceItemList
        provider="github"
        items={ITEMS}
        selectedKeys={new Set(['acme/web'])}
        onSelectionChange={onSelectionChange}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /acme\/web for team/i }));
    expect(onSelectionChange).toHaveBeenCalledWith('acme/web', false);
  });

  it('is fully controlled: checked state follows selectedKeys, not internal clicks', async () => {
    // No onSelectionChange wired → a click reports nothing and the prop-driven
    // checked state does not change on its own.
    render(<SourceItemList provider="github" items={ITEMS} selectedKeys={new Set()} />);
    const cb = screen.getByRole('checkbox', { name: /acme\/api for team/i });
    await userEvent.click(cb);
    expect(cb).not.toBeChecked();
  });
});
