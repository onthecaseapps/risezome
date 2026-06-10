'use client';

import { useMemo, useState, type ReactElement } from 'react';

/**
 * Audit log — client interactivity (search, filter pills, CSV export, grouped +
 * expandable table). Pure-render-from-props: the server page (page.tsx) does all
 * the async enrichment and hands down a fully serialized `entries` array, so this
 * component never awaits anything. Theme tokens only (bg-card / text-fg / etc.)
 * so it tracks light AND dark — the mockup is dark but the app is dual-theme.
 */

/** One canonical category. Order here IS the pill order (privacy → … → gap). */
export type Category =
  | 'privacy_change'
  | 'role_change'
  | 'team_membership'
  | 'master_key_access'
  | 'admin_override'
  | 'gap_assignment';

/**
 * Category presentation. NOTE: the mockup also drew a "Bot setting" pill, but
 * there is NO bot-setting action in the audit system yet — bot-setting auditing
 * isn't implemented, so that pill is intentionally OMITTED here. Add a category
 * + an `action` mapping in page.tsx if/when bot-setting events start landing.
 */
export const CATEGORY_META: Record<
  Category,
  { label: string; dot: string; iconBg: string; iconFg: string; icon: ReactElement }
> = {
  privacy_change: {
    label: 'Privacy change',
    dot: 'bg-amber-500',
    iconBg: 'bg-amber-500/15',
    iconFg: 'text-amber-500',
    icon: <EyeIcon />,
  },
  role_change: {
    label: 'Role change',
    dot: 'bg-yellow-500',
    iconBg: 'bg-yellow-500/15',
    iconFg: 'text-yellow-500',
    icon: <ShieldIcon />,
  },
  team_membership: {
    label: 'Team membership',
    dot: 'bg-teal-500',
    iconBg: 'bg-teal-500/15',
    iconFg: 'text-teal-500',
    icon: <PeopleIcon />,
  },
  master_key_access: {
    label: 'Master-key access',
    dot: 'bg-rose-500',
    iconBg: 'bg-rose-500/15',
    iconFg: 'text-rose-500',
    icon: <KeyIcon />,
  },
  admin_override: {
    label: 'Admin override',
    dot: 'bg-indigo-500',
    iconBg: 'bg-indigo-500/15',
    iconFg: 'text-indigo-500',
    icon: <BoltIcon />,
  },
  gap_assignment: {
    label: 'Gap assignment',
    dot: 'bg-sky-500',
    iconBg: 'bg-sky-500/15',
    iconFg: 'text-sky-500',
    icon: <TargetIcon />,
  },
};

/** Canonical pill order (mirrors CATEGORY_META declaration order). */
const CATEGORY_ORDER: Category[] = [
  'privacy_change',
  'role_change',
  'team_membership',
  'master_key_access',
  'admin_override',
  'gap_assignment',
];

export interface AuditEntry {
  id: number;
  createdAt: string;
  actorId: string;
  actorName: string;
  category: Category;
  action: string;
  title: string;
  sensitive: boolean;
  description: string;
  targetLabel: string | null;
  targetHref: string | null;
  /** Raw detail JSON for the expand panel (already plain/serializable). */
  detail: Record<string, unknown> | null;
  /** Lowercased actorName + title + description + targetLabel, for search. */
  searchText: string;
}

export function AuditLogClient({
  entries,
  orgName,
}: {
  entries: AuditEntry[];
  orgName: string;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all');
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // Pills: "All events" + only the categories actually present, canonical order.
  const presentCategories = useMemo(() => {
    const present = new Set(entries.map((e) => e.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (activeCategory !== 'all' && e.category !== activeCategory) return false;
      if (q.length > 0 && !e.searchText.includes(q)) return false;
      return true;
    });
  }, [entries, query, activeCategory]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  function toggle(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportCsv(): void {
    const csv = buildCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${slugify(orgName)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search actor, target, action"
            aria-label="Search audit log"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="flex flex-shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-accent-soft/50 disabled:cursor-default disabled:opacity-50"
        >
          <DownloadIcon />
          Export CSV
        </button>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <Pill active={activeCategory === 'all'} onClick={() => setActiveCategory('all')}>
          All events
        </Pill>
        {presentCategories.map((c) => {
          const meta = CATEGORY_META[c];
          return (
            <Pill key={c} active={activeCategory === c} onClick={() => setActiveCategory(c)}>
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
              {meta.label}
            </Pill>
          );
        })}
      </div>

      {entries.length === 0 ? (
        <EmptyCard>No permission events recorded yet.</EmptyCard>
      ) : filtered.length === 0 ? (
        <EmptyCard>No events match your filters.</EmptyCard>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border shadow-[var(--card-shadow)]">
          <div className="grid grid-cols-[minmax(140px,1fr)_minmax(160px,1fr)_3fr_auto] gap-4 border-b border-border bg-card/40 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <span>When</span>
            <span>Actor</span>
            <span>Event</span>
            <span className="w-6" aria-hidden="true" />
          </div>

          {groups.map((group) => (
            <div key={group.key}>
              <div className="border-b border-border bg-card/40 px-5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                {group.label}
              </div>
              <ul>
                {group.entries.map((e) => (
                  <Row
                    key={e.id}
                    entry={e}
                    expanded={expanded.has(e.id)}
                    onToggle={() => toggle(e.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-muted">
        <LockIcon />
        Append-only · entries cannot be edited or deleted · retained for 18 months
      </p>
    </div>
  );
}

function Row({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const meta = CATEGORY_META[entry.category];
  const avatarColor = colorForActor(entry.actorId.length > 0 ? entry.actorId : entry.actorName);
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="grid grid-cols-[minmax(140px,1fr)_minmax(160px,1fr)_3fr_auto] items-start gap-4 px-5 py-3 text-sm">
        <div className="min-w-0">
          <div className="text-fg" title={entry.createdAt}>
            {formatAbsolute(entry.createdAt)}
          </div>
          <div className="text-xs text-faint">{relativeTime(entry.createdAt)}</div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${avatarColor}`}
            aria-hidden="true"
          >
            {initialsFor(entry.actorName)}
          </span>
          <span className="truncate text-fg" title={entry.actorName}>
            {entry.actorName}
          </span>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${meta.iconBg} ${meta.iconFg}`}
              aria-hidden="true"
            >
              {meta.icon}
            </span>
            <span className="font-semibold text-fg">{meta.label}</span>
            {entry.sensitive ? (
              <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-500">
                Sensitive
              </span>
            ) : null}
            {entry.targetLabel !== null ? (
              <span className="truncate text-muted">
                ·{' '}
                {entry.targetHref !== null ? (
                  <a href={entry.targetHref} className="text-accent hover:underline">
                    {entry.targetLabel}
                  </a>
                ) : (
                  entry.targetLabel
                )}
              </span>
            ) : null}
          </div>
          {entry.description.length > 0 ? (
            <div className="mt-0.5 text-xs text-muted">{entry.description}</div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse detail' : 'Expand detail'}
          className="rounded-md p-1 text-muted hover:bg-bg hover:text-fg"
        >
          <ChevronIcon up={expanded} />
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-border bg-card/40 px-5 py-3 text-xs">
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5">
            <DetailRow label="Timestamp" value={formatFull(entry.createdAt)} />
            <DetailRow label="Actor" value={`${entry.actorName} (${entry.actorId})`} />
            <DetailRow label="Action" value={entry.action} />
            <DetailRow label="Target" value={entry.targetLabel ?? '—'} />
            {entry.detail !== null
              ? Object.entries(entry.detail).map(([k, v]) => (
                  <DetailRow key={k} label={k} value={stringifyValue(v)} />
                ))
              : null}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words text-fg">{value}</dd>
    </>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border bg-card text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center text-sm text-muted shadow-[var(--card-shadow)]">
      {children}
    </div>
  );
}

/* ---------- Pure helpers (unit-tested directly) ---------- */

interface DayGroup {
  key: string;
  label: string;
  entries: AuditEntry[];
}

/** Group entries (already filtered, newest-first) by local calendar day. */
export function groupByDay(entries: AuditEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const e of entries) {
    const d = new Date(e.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, label: dayLabel(d), entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(e);
  }
  return groups;
}

function dayLabel(d: Date): string {
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return 'Today';
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "2h ago" / "Yesterday" / "3 days ago"; coarse, plain Date math. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** RFC-4180-ish CSV from the currently filtered entries. */
export function buildCsv(entries: AuditEntry[]): string {
  const header = ['When', 'Actor', 'Category', 'Target', 'Description'];
  const rows = entries.map((e) => [
    e.createdAt,
    e.actorName,
    CATEGORY_META[e.category].label,
    e.targetLabel ?? '',
    e.description,
  ]);
  return [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value: string): string {
  // CSV/formula-injection guard: audit fields carry user-controlled text (actor
  // names, team/meeting titles, descriptions). A cell starting with a formula
  // trigger executes when the CSV is opened in Excel/Sheets, so prefix those with
  // a single quote to neutralise them. Applied to every cell, before quoting.
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  );
}

export function initialsFor(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '?';
  const parts = trimmed.split(/[\s.@]+/).filter((s) => s.length > 0);
  if (parts.length === 0) return trimmed.charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

const AVATAR_PALETTE = [
  'bg-rose-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-teal-500',
  'bg-sky-500',
  'bg-indigo-500',
  'bg-violet-500',
  'bg-fuchsia-500',
];

/** Deterministic avatar color from the actor key (id or name). */
export function colorForActor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!;
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/* ---------- Icons (stroke = currentColor; size 14-16) ---------- */

function SearchIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function DownloadIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: up ? 'rotate(180deg)' : undefined }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function LockIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function EyeIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ShieldIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 3v6c0 4.5-3 7.5-8 9-5-1.5-8-4.5-8-9V6l8-3Z" />
    </svg>
  );
}

function PeopleIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function KeyIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 8.3-8.3" />
      <path d="m16 5 3 3" />
      <path d="m18 7 2-2" />
    </svg>
  );
}

function BoltIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
    </svg>
  );
}

function TargetIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}
