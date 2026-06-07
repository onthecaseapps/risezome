import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AuditLogClient,
  type AuditEntry,
  type Category,
  buildCsv,
  groupByDay,
  relativeTime,
  colorForActor,
  slugify,
  initialsFor,
} from '../../app/(authed)/settings/audit/_audit-log-client';

function entry(over: Partial<AuditEntry> & { id: number; category: Category }): AuditEntry {
  const base: AuditEntry = {
    id: over.id,
    // Default to "now" so day-grouping lands under "Today" regardless of clock.
    createdAt: new Date().toISOString(),
    actorId: `actor-${over.id}`,
    actorName: 'Jordan Lee',
    category: over.category,
    action: over.category,
    title: 'Event',
    sensitive: false,
    description: '',
    targetLabel: null,
    targetHref: null,
    detail: null,
    searchText: '',
  };
  const merged = { ...base, ...over };
  // Mirror the server's searchText contract unless the test overrides it.
  if (over.searchText === undefined) {
    merged.searchText = [merged.actorName, merged.title, merged.description, merged.targetLabel ?? '']
      .join(' ')
      .toLowerCase();
  }
  return merged;
}

function fixture(): AuditEntry[] {
  return [
    entry({
      id: 1,
      category: 'role_change',
      title: 'Role change',
      actorName: 'Jordan Lee',
      description: 'Member → Admin',
      targetLabel: 'Sam Rivera',
    }),
    entry({
      id: 2,
      category: 'master_key_access',
      title: 'Master-key access',
      actorName: 'Alex Chen',
      sensitive: true,
      description: 'Accessed under master key (legal hold)',
      targetLabel: 'Q3 Planning',
      targetHref: '/meetings/m1/review',
      detail: { reason: 'legal hold' },
    }),
    entry({
      id: 3,
      category: 'team_membership',
      title: 'Team membership',
      actorName: 'Jordan Lee',
      description: 'Added Casey to Platform',
    }),
  ];
}

describe('AuditLogClient', () => {
  it('renders grouped rows with a day-group header', () => {
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    // One <li> per entry, all under one "Today" day-group header (fixed dates).
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Today')).toBeInTheDocument();
    // Each row carries its unique description.
    expect(screen.getByText('Member → Admin')).toBeInTheDocument();
    expect(screen.getByText('Accessed under master key (legal hold)')).toBeInTheDocument();
    expect(screen.getByText('Added Casey to Platform')).toBeInTheDocument();
    // Column headers.
    expect(screen.getByText('When')).toBeInTheDocument();
    expect(screen.getByText('Actor')).toBeInTheDocument();
    expect(screen.getByText('Event')).toBeInTheDocument();
  });

  it('only renders pills for categories present in the data, plus All events', () => {
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    expect(screen.getByRole('button', { name: /all events/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /role change/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /master-key access/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /team membership/i })).toBeInTheDocument();
    // Privacy change has no entry → no pill.
    expect(screen.queryByRole('button', { name: /^privacy change$/i })).not.toBeInTheDocument();
  });

  it('filter pills narrow to a category (Role change hides master-key rows)', async () => {
    const user = userEvent.setup();
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    await user.click(screen.getByRole('button', { name: /role change/i }));
    // One row left; identify rows by their unique descriptions.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Member → Admin')).toBeInTheDocument();
    expect(screen.queryByText('Accessed under master key (legal hold)')).not.toBeInTheDocument();
    expect(screen.queryByText('Added Casey to Platform')).not.toBeInTheDocument();
  });

  it('search narrows by actor / target / description substring', async () => {
    const user = userEvent.setup();
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    const box = screen.getByRole('searchbox', { name: /search audit log/i });
    await user.type(box, 'alex');
    // Only Alex Chen's master-key row remains.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Accessed under master key (legal hold)')).toBeInTheDocument();
    expect(screen.queryByText('Member → Admin')).not.toBeInTheDocument();
  });

  it('shows the SENSITIVE badge only on master-key rows', () => {
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    const badges = screen.getAllByText(/sensitive/i);
    expect(badges).toHaveLength(1);
  });

  it('expands a row to reveal its detail panel', async () => {
    const user = userEvent.setup();
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    // Find the master-key row by its description, then its expand button.
    const row = screen
      .getByText('Accessed under master key (legal hold)')
      .closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /expand detail/i }));
    // The detail panel surfaces the raw detail key (reason) and the Action label.
    expect(within(row).getByText('Action')).toBeInTheDocument();
    expect(within(row).getByText('reason')).toBeInTheDocument();
  });

  it('renders the empty state when there are no entries', () => {
    render(<AuditLogClient entries={[]} orgName="Acme" />);
    expect(screen.getByText(/no permission events recorded yet/i)).toBeInTheDocument();
  });

  it('shows a filtered-empty state when search matches nothing', async () => {
    const user = userEvent.setup();
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    await user.type(screen.getByRole('searchbox', { name: /search audit log/i }), 'zzzznope');
    expect(screen.getByText(/no events match your filters/i)).toBeInTheDocument();
  });

  it('renders a target link only when targetHref is set', () => {
    render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    const link = screen.getByRole('link', { name: 'Q3 Planning' });
    expect(link).toHaveAttribute('href', '/meetings/m1/review');
    // The role_change target (Sam Rivera) has no href → plain text, not a link.
    expect(screen.queryByRole('link', { name: 'Sam Rivera' })).not.toBeInTheDocument();
  });

  it('enables the Export CSV button when entries exist and disables it when empty', () => {
    const { rerender } = render(<AuditLogClient entries={fixture()} orgName="Acme" />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeEnabled();
    rerender(<AuditLogClient entries={[]} orgName="Acme" />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
  });
});

describe('pure helpers', () => {
  it('groupByDay groups consecutive same-day entries into one group', () => {
    const groups = groupByDay([
      entry({ id: 1, category: 'role_change', createdAt: '2026-06-06T10:00:00Z' }),
      entry({ id: 2, category: 'role_change', createdAt: '2026-06-06T22:00:00Z' }),
      entry({ id: 3, category: 'role_change', createdAt: '2026-06-01T09:00:00Z' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries).toHaveLength(2);
    expect(groups[1]!.entries).toHaveLength(1);
  });

  it('relativeTime renders coarse buckets', () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 30 * 1000).toISOString())).toBe('just now');
    expect(relativeTime(new Date(now - 5 * 60 * 1000).toISOString())).toBe('5m ago');
    expect(relativeTime(new Date(now - 3 * 3600 * 1000).toISOString())).toBe('3h ago');
    expect(relativeTime(new Date(now - 26 * 3600 * 1000).toISOString())).toBe('Yesterday');
    expect(relativeTime(new Date(now - 3 * 86400 * 1000).toISOString())).toBe('3 days ago');
  });

  it('buildCsv emits a header + escapes commas and quotes', () => {
    const csv = buildCsv([
      entry({
        id: 1,
        category: 'role_change',
        actorName: 'Jordan Lee',
        description: 'Member, then "Admin"',
        targetLabel: 'Sam',
        createdAt: '2026-06-06T10:42:00.000Z',
      }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('When,Actor,Category,Target,Description');
    expect(lines[1]).toContain('Jordan Lee');
    expect(lines[1]).toContain('"Member, then ""Admin"""');
  });

  it('colorForActor is deterministic and returns a bg-*-500 class', () => {
    expect(colorForActor('actor-1')).toBe(colorForActor('actor-1'));
    expect(colorForActor('actor-1')).toMatch(/^bg-[a-z]+-500$/);
  });

  it('slugify normalizes and falls back to workspace', () => {
    expect(slugify('Acme Corp!')).toBe('acme-corp');
    expect(slugify('---')).toBe('workspace');
  });

  it('initialsFor derives up to two initials', () => {
    expect(initialsFor('Jordan Lee')).toBe('JL');
    expect(initialsFor('jordan@acme.dev')).toBe('JA');
    expect(initialsFor('')).toBe('?');
  });
});
