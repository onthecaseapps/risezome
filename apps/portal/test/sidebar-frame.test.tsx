import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarFrame } from '../app/(authed)/_components/sidebar-frame';

const STORAGE_KEY = 'rz.sidebar.collapsed';

function rail(): HTMLElement {
  // The <aside> carries the data-collapsed marker.
  return document.querySelector('aside') as HTMLElement;
}

describe('SidebarFrame collapse toggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders collapsed by default with an Expand control', () => {
    render(<SidebarFrame nav={<span>nav</span>} />);
    expect(rail().getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it('toggles to expanded and persists the choice', async () => {
    const user = userEvent.setup();
    render(<SidebarFrame nav={<span>nav</span>} />);
    await user.click(screen.getByRole('button', { name: /expand sidebar/i }));
    expect(rail().getAttribute('data-collapsed')).toBe('false');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false');
    // The control now collapses.
    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(rail().getAttribute('data-collapsed')).toBe('true');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('applies the persisted expanded preference on mount', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'false');
    render(<SidebarFrame nav={<span>nav</span>} />);
    // useEffect applies the stored preference after the first paint.
    expect(await screen.findByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
    expect(rail().getAttribute('data-collapsed')).toBe('false');
  });
});
