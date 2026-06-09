'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { AssignedQuestionView, GapView, NotificationView, OrgMember, SectionView } from './_types';
import { ChevronDown, FlameGlyph, SectionDot, StatusPill, Avatar, shortDate } from './_bits';
import { GapsEmptyState } from './_empty-state';
import { GapRow } from './_gap-row';
import { GapDrawer } from './_gap-drawer';
import { GapToasts } from './_notifications';
import { MergeGapDialog, MoveGapDialog, SectionMenu } from './_curation';
import { assignGapAction } from './gap-actions';

type StatusFilter = 'open' | 'resolved' | 'dismissed' | 'all';
type SortKey = 'mostAsked' | 'newest' | 'unassigned';

const UNCATEGORIZED = '__uncategorized__';

export function GapsClient({
  gaps,
  sections,
  members,
  isManager,
  currentUserId,
  notifications,
  assignedQuestions = [],
}: {
  gaps: GapView[];
  sections: SectionView[];
  members: OrgMember[];
  isManager: boolean;
  currentUserId: string;
  notifications: NotificationView[];
  assignedQuestions?: AssignedQuestionView[];
}): ReactElement {
  const [query, setQuery] = useState('');
  const [sectionFilter, setSectionFilter] = useState<string>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [sort, setSort] = useState<SortKey>('mostAsked');

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openGapId, setOpenGapId] = useState<string | null>(null);
  const [moveGapId, setMoveGapId] = useState<string | null>(null);
  const [mergeGapId, setMergeGapId] = useState<string | null>(null);

  // Clock is null through SSR + first paint so relative-time labels can't cause
  // a hydration mismatch; refines after mount.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const sectionById = useMemo(() => new Map(sections.map((s) => [s.sectionId, s])), [sections]);
  const gapById = useMemo(() => new Map(gaps.map((g) => [g.gapId, g])), [gaps]);

  // ── stat counters ─────────────────────────────────────────────────────────
  const openCount = useMemo(() => gaps.filter((g) => g.status === 'open').length, [gaps]);
  const unassignedCount = useMemo(
    () => gaps.filter((g) => g.status === 'open' && g.assigneeId === null).length,
    [gaps],
  );

  // ── most-asked gap this month (hero) ───────────────────────────────────────
  const hero = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = gaps.filter(
      (g) => g.lastAskedAtIso !== null && new Date(g.lastAskedAtIso).getTime() >= cutoff,
    );
    if (recent.length === 0) return null;
    return recent.reduce((best, g) => (g.frequency > best.frequency ? g : best), recent[0]!);
  }, [gaps]);

  // ── my assignment banner ───────────────────────────────────────────────────
  const myGaps = useMemo(
    () => gaps.filter((g) => g.assigneeId === currentUserId && g.status === 'open'),
    [gaps, currentUserId],
  );

  // ── filter + sort ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = gaps.filter((g) => {
      if (q.length > 0) {
        const hay = [g.title, ...g.occurrences.map((o) => o.verbatimQuestion)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter !== 'all' && g.status !== statusFilter) return false;
      if (sectionFilter !== 'all') {
        const key = g.sectionId ?? UNCATEGORIZED;
        if (key !== sectionFilter) return false;
      }
      if (assigneeFilter !== 'all') {
        if (assigneeFilter === 'unassigned' && g.assigneeId !== null) return false;
        if (assigneeFilter !== 'unassigned' && g.assigneeId !== assigneeFilter) return false;
      }
      if (assignedToMe && g.assigneeId !== currentUserId) return false;
      return true;
    });

    matches.sort((a, b) => {
      switch (sort) {
        case 'newest':
          return time(b) - time(a);
        case 'unassigned':
          return Number(a.assigneeId !== null) - Number(b.assigneeId !== null) || b.frequency - a.frequency;
        case 'mostAsked':
        default:
          return b.frequency - a.frequency;
      }
    });
    return matches;
  }, [gaps, query, statusFilter, sectionFilter, assigneeFilter, assignedToMe, sort, currentUserId]);

  // ── group by section ───────────────────────────────────────────────────────
  const groups = useMemo(() => groupBySection(filtered, sections), [filtered, sections]);

  const openGap = openGapId !== null ? (gapById.get(openGapId) ?? null) : null;
  const moveGap = moveGapId !== null ? (gapById.get(moveGapId) ?? null) : null;
  const mergeGap = mergeGapId !== null ? (gapById.get(mergeGapId) ?? null) : null;

  function toggleSection(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Knowledge gaps</h1>
          <p className="mt-2 max-w-xl text-pretty text-muted">
            Questions Risezome couldn&apos;t answer in meetings, captured automatically and ranked by how
            often your team asks.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <StatChip label="Open" value={openCount} />
          <StatChip label="Unassigned" value={unassignedCount} />
          <StatChip label="Sections" value={sections.length} />
        </div>
      </header>

      {/* my-assignments banner */}
      {myGaps.length > 0 ? (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3 text-sm">
          <BellGlyph />
          <span className="text-fg">
            <span className="font-semibold">{myGaps.length}</span>{' '}
            {myGaps.length === 1 ? 'gap is' : 'gaps are'} assigned to you · {myGaps.length}{' '}
            {myGaps.length === 1 ? 'needs' : 'need'} an answer this week.
          </span>
        </div>
      ) : null}

      {/* Assigned to you — METADATA-ONLY (U8 / U5 deferred). Surfaces the
          caller's assigned questions for a NON-attendee assignee who can't open
          the gap itself, so it is a PLAIN read-only list: question, asker,
          recurrence, status — and deliberately NO link through to the gap drawer
          or verbatim. Empty → render nothing (no noisy empty state). */}
      {assignedQuestions.length > 0 ? (
        <section className="mb-6 overflow-hidden rounded-2xl border border-border">
          <div className="flex items-center gap-2 bg-card/40 px-4 py-2.5">
            <span className="text-sm font-semibold text-fg">Assigned to you</span>
            <span className="flex-none rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-medium text-muted">
              {assignedQuestions.length}
            </span>
          </div>
          <ul>
            {assignedQuestions.map((q) => (
              <li
                key={q.gapId}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{q.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {q.askerName !== null ? `Asked by ${q.askerName}` : 'Asked in a meeting'}
                    {' · '}
                    <span className="inline-flex items-center gap-1">
                      <FlameGlyph className="text-orange-400" />
                      {q.frequency}× asked
                    </span>
                    {q.lastAskedAtIso !== null ? ` · last ${shortDate(q.lastAskedAtIso)}` : ''}
                  </p>
                </div>
                <StatusPill status={q.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* hero */}
      {hero !== null ? (
        <HeroBanner gap={hero} section={hero.sectionId !== null ? (sectionById.get(hero.sectionId) ?? null) : null} onOpen={() => setOpenGapId(hero.gapId)} />
      ) : null}

      {/* toolbar */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search gaps…"
            className="w-full rounded-xl border border-border bg-card/60 py-2.5 pl-10 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
          />
        </div>
        <Select
          value={sectionFilter}
          onChange={setSectionFilter}
          options={[
            { value: 'all', label: 'All sections' },
            { value: UNCATEGORIZED, label: 'Uncategorized' },
            ...sections.map((s) => ({ value: s.sectionId, label: s.name })),
          ]}
        />
        <Select
          value={assigneeFilter}
          onChange={setAssigneeFilter}
          options={[
            { value: 'all', label: 'All assignees' },
            { value: 'unassigned', label: 'Unassigned' },
            ...members.map((m) => ({ value: m.userId, label: m.name })),
          ]}
        />
        <Select
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'dismissed', label: 'Dismissed' },
            { value: 'all', label: 'All statuses' },
          ]}
        />
        <button
          type="button"
          onClick={() => setAssignedToMe((v) => !v)}
          className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
            assignedToMe ? 'border-accent/50 bg-accent-soft text-accent' : 'border-border bg-card/60 text-fg hover:border-accent/40'
          }`}
        >
          Assigned to me
        </button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Sort</span>
          <Select
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={[
              { value: 'mostAsked', label: 'Most asked' },
              { value: 'newest', label: 'Newest' },
              { value: 'unassigned', label: 'Unassigned' },
            ]}
          />
        </div>
      </div>

      {/* list */}
      {gaps.length === 0 ? (
        <GapsEmptyState isManager={isManager} />
      ) : filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center text-sm text-muted">
          No gaps match these filters.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const section = group.sectionId !== null ? (sectionById.get(group.sectionId) ?? null) : null;
            const otherSections = sections.filter((s) => s.sectionId !== group.sectionId);
            return (
              <section key={group.key} className="rounded-2xl border border-border">
                {/* No overflow-hidden on the section — it would clip a row's kebab
                    dropdown (which opens below the row). Round the header + last
                    row directly so corners stay clean in both states. */}
                <div
                  className={`flex items-center justify-between gap-3 bg-card/40 px-4 py-2.5 ${
                    isCollapsed ? 'rounded-2xl' : 'rounded-t-2xl'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSection(group.key)}
                    className="flex min-w-0 items-center gap-2 text-left"
                  >
                    <ChevronDown className={`text-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                    {section !== null ? <SectionDot color={section.color} /> : null}
                    <span className="truncate text-sm font-semibold text-fg">{group.name}</span>
                    <span className="flex-none rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-medium text-muted">
                      {group.gaps.length}
                    </span>
                  </button>
                  {isManager && section !== null ? (
                    <SectionMenu section={section} otherSections={otherSections} gapCount={group.gaps.length} />
                  ) : null}
                </div>
                {!isCollapsed ? (
                  <div>
                    {group.gaps.map((g) => (
                      <GapRow
                        key={g.gapId}
                        gap={g}
                        members={members}
                        isManager={isManager}
                        now={now}
                        onOpen={() => setOpenGapId(g.gapId)}
                        onAssign={(userId) => {
                          void assignGapAction(g.gapId, userId);
                        }}
                        onMerge={() => setMergeGapId(g.gapId)}
                        onMoveSection={() => setMoveGapId(g.gapId)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}

      {/* drawer */}
      {openGap !== null ? (
        <GapDrawer
          gap={openGap}
          sections={sections}
          members={members}
          isManager={isManager}
          now={now}
          onClose={() => setOpenGapId(null)}
        />
      ) : null}

      {/* curation dialogs */}
      {moveGap !== null ? (
        <MoveGapDialog gap={moveGap} sections={sections} onClose={() => setMoveGapId(null)} />
      ) : null}
      {mergeGap !== null ? (
        <MergeGapDialog
          gap={mergeGap}
          candidates={gaps.filter((g) => g.gapId !== mergeGap.gapId)}
          onClose={() => setMergeGapId(null)}
        />
      ) : null}

      {/* assignment toasts */}
      <GapToasts notifications={notifications} onView={(gapId) => setOpenGapId(gapId)} />
    </div>
  );
}

// ── hero ─────────────────────────────────────────────────────────────────────

function HeroBanner({
  gap,
  section,
  onOpen,
}: {
  gap: GapView;
  section: SectionView | null;
  onOpen: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-6 flex w-full items-center gap-5 rounded-2xl border border-orange-400/30 bg-orange-400/5 px-5 py-4 text-left transition-colors hover:border-orange-400/50"
    >
      <span className="flex h-12 w-12 flex-none items-center justify-center rounded-xl bg-orange-400/15 text-orange-400">
        <FlameGlyph className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-400">Most-asked gap this month</p>
        <p className="mt-0.5 flex items-center gap-2">
          <span className="text-2xl font-bold tabular-nums text-orange-400">{gap.frequency}×</span>
          <span className="truncate text-base font-semibold text-fg">{gap.title}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Asked by {gap.people} {gap.people === 1 ? 'person' : 'people'} across {gap.meetings}{' '}
          {gap.meetings === 1 ? 'meeting' : 'meetings'}
          {section !== null ? ` · in ${section.name}` : ''}
        </p>
      </div>
      <div className="flex flex-none items-center gap-3">
        {gap.assigneeName !== null ? <Avatar name={gap.assigneeName} size={8} /> : null}
        <StatusPill status={gap.status} />
      </div>
    </button>
  );
}

// ── stat chip ─────────────────────────────────────────────────────────────────

function StatChip({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-3.5 py-2 text-center">
      <div className="text-lg font-bold tabular-nums leading-none text-fg">{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}

// ── select ─────────────────────────────────────────────────────────────────────

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): ReactElement {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none rounded-xl border border-border bg-card/60 py-2.5 pl-3.5 pr-9 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function time(g: GapView): number {
  return new Date(g.lastAskedAtIso ?? g.firstAskedAtIso ?? 0).getTime();
}

interface SectionGroup {
  key: string;
  sectionId: string | null;
  name: string;
  gaps: GapView[];
}

function groupBySection(gaps: GapView[], sections: SectionView[]): SectionGroup[] {
  const byKey = new Map<string, GapView[]>();
  for (const g of gaps) {
    const key = g.sectionId ?? UNCATEGORIZED;
    const list = byKey.get(key) ?? [];
    list.push(g);
    byKey.set(key, list);
  }
  const out: SectionGroup[] = [];
  for (const s of sections) {
    const list = byKey.get(s.sectionId);
    if (list !== undefined && list.length > 0) {
      out.push({ key: s.sectionId, sectionId: s.sectionId, name: s.name, gaps: list });
    }
  }
  const uncategorized = byKey.get(UNCATEGORIZED);
  if (uncategorized !== undefined && uncategorized.length > 0) {
    out.push({ key: UNCATEGORIZED, sectionId: null, name: 'Uncategorized', gaps: uncategorized });
  }
  return out;
}

// ── glyphs ─────────────────────────────────────────────────────────────────

function SearchIcon(): ReactElement {
  return (
    <svg
      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function BellGlyph(): ReactElement {
  return (
    <svg className="flex-none text-accent" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}
