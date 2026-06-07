import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsNav } from '../app/(authed)/settings/_nav';

let mockPathname = '/settings/meeting-bot';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

describe('SettingsNav', () => {
  it('renders all categories', () => {
    mockPathname = '/settings/meeting-bot';
    render(<SettingsNav />);
    for (const label of ['Profile', 'Workspace', 'Meeting bot', 'Teams & members', 'Billing', 'Audit log']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('points the Teams & members category at /settings/teams', () => {
    mockPathname = '/settings/meeting-bot';
    render(<SettingsNav />);
    expect(screen.getByRole('link', { name: 'Teams & members' })).toHaveAttribute('href', '/settings/teams');
  });

  it('marks the active category by pathname', () => {
    mockPathname = '/settings/meeting-bot';
    render(<SettingsNav />);
    expect(screen.getByRole('link', { name: 'Meeting bot' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Workspace' })).not.toHaveAttribute('aria-current');
  });

  it('treats a nested path as active for its category', () => {
    mockPathname = '/settings/billing/history';
    render(<SettingsNav />);
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('aria-current', 'page');
  });
});
