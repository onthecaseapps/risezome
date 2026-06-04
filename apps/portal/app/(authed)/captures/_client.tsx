'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { PRIVACY_LABEL, type PrivacyLevel } from '../../_lib/privacy-levels';

export type CapturePlatform = 'zoom' | 'meet' | 'teams' | 'other';

export interface CaptureCard {
  meetingId: string;
  /** Empty string → rendered as italic "Untitled meeting". */
  title: string;
  status: 'completed' | 'failed';
  startedAtIso: string | null;
  endedAtIso: string | null;
  createdAtIso: string;
  platform: CapturePlatform;
  privacyLevel: PrivacyLevel;
  summary: string | null;
  recapStatus: 'generating' | 'done' | 'failed' | null;
  answersCount: number;
  sourcesCount: number;
  speakers: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

type PlatformFilter = 'all' | CapturePlatform;
type LengthFilter = 'any' | 'short' | 'medium' | 'long';
type AnswersFilter = 'all' | 'has' | 'none';
type SortKey = 'recent' | 'oldest' | 'longest' | 'answers';

export function CapturesClient({
  captures,
  orgName,
}: {
  captures: CaptureCard[];
  orgName: string;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [length, setLength] = useState<LengthFilter>('any');
  const [answers, setAnswers] = useState<AnswersFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = captures.filter((c) => {
      if (q.length > 0) {
        const hay = [c.title, c.summary ?? '', ...c.speakers].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (platform !== 'all' && c.platform !== platform) return false;
      if (answers === 'has' && c.answersCount === 0) return false;
      if (answers === 'none' && c.answersCount > 0) return false;
      if (length !== 'any') {
        const m = durationMin(c);
        if (length === 'short' && !(m !== null && m < 15)) return false;
        if (length === 'medium' && !(m !== null && m >= 15 && m <= 30)) return false;
        if (length === 'long' && !(m !== null && m > 30)) return false;
      }
      return true;
    });

    const byTime = (c: CaptureCard): number => new Date(c.startedAtIso ?? c.createdAtIso).getTime();
    matches.sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return byTime(a) - byTime(b);
        case 'longest':
          return (durationMin(b) ?? -1) - (durationMin(a) ?? -1);
        case 'answers':
          return b.answersCount - a.answersCount;
        case 'recent':
        default:
          return byTime(b) - byTime(a);
      }
    });
    return matches;
  }, [captures, query, platform, length, answers, sort]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8">
      <header className="mb-7">
        <h1 className="text-4xl font-bold tracking-tight">Captures</h1>
        <p className="mt-2 text-pretty text-muted">
          The shared library of past meetings for{' '}
          <span className="font-medium text-fg">{orgName}</span> — workspace-visible captures plus
          any private ones you can see.
        </p>
      </header>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings, topics, people…"
            className="w-full rounded-xl border border-border bg-card/60 py-2.5 pl-10 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
          />
        </div>
        <FilterSelect value={platform} onChange={(v) => setPlatform(v as PlatformFilter)} options={PLATFORM_OPTIONS} />
        <FilterSelect value={length} onChange={(v) => setLength(v as LengthFilter)} options={LENGTH_OPTIONS} />
        <FilterSelect value={answers} onChange={(v) => setAnswers(v as AnswersFilter)} options={ANSWERS_OPTIONS} />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Sort</span>
          <FilterSelect value={sort} onChange={(v) => setSort(v as SortKey)} options={SORT_OPTIONS} />
        </div>
      </div>

      {captures.length === 0 ? (
        <EmptyState />
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center text-sm text-muted">
          No captures match these filters.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.dayKey}>
              <div className="mb-4 flex items-center gap-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{group.day}</h2>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {group.items.map((c) => (
                  <CaptureCardView key={c.meetingId} capture={c} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const PLATFORM_OPTIONS = [
  { value: 'all', label: 'All platforms' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'meet', label: 'Google Meet' },
  { value: 'teams', label: 'Teams' },
  { value: 'other', label: 'Other' },
];
const LENGTH_OPTIONS = [
  { value: 'any', label: 'Any length' },
  { value: 'short', label: 'Under 15m' },
  { value: 'medium', label: '15–30m' },
  { value: 'long', label: 'Over 30m' },
];
const ANSWERS_OPTIONS = [
  { value: 'all', label: 'All answers' },
  { value: 'has', label: 'With answers' },
  { value: 'none', label: 'No answers' },
];
const SORT_OPTIONS = [
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'longest', label: 'Longest' },
  { value: 'answers', label: 'Most answers' },
];

function FilterSelect({
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
      <ChevronDown />
    </div>
  );
}

function CaptureCardView({ capture: c }: { capture: CaptureCard }): ReactElement {
  const dur = durationMin(c);
  const time = c.startedAtIso !== null ? formatTime(c.startedAtIso) : formatTime(c.createdAtIso);
  return (
    <a
      href={`/meetings/${c.meetingId}/review`}
      className="group flex flex-col rounded-2xl border border-border bg-card/50 p-5 transition-colors hover:border-accent/40 hover:bg-card"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <PlatformIcon platform={c.platform} />
          <span className="text-sm text-muted">{time}</span>
        </div>
        <div className="flex items-center gap-2">
          <PrivacyBadge level={c.privacyLevel} />
          <span className={`text-sm font-medium ${PLATFORM_TEXT[c.platform]}`}>
            {PLATFORM_LABEL[c.platform]}
          </span>
          <StatusBadge status={c.status} />
        </div>
      </div>

      <h3 className="mt-3.5 text-pretty text-lg font-semibold leading-snug tracking-tight">
        {c.title.length > 0 ? (
          <span className="text-fg group-hover:text-accent">{c.title}</span>
        ) : (
          <span className="italic text-muted">Untitled meeting</span>
        )}
      </h3>

      <p className="mt-1.5 line-clamp-2 min-h-[2.5em] text-pretty text-sm leading-relaxed text-muted">
        {summaryLine(c)}
      </p>

      <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3.5">
        <div className="flex items-center gap-3.5 text-xs text-muted">
          <Metric icon={<SparkleGlyph />} value={c.answersCount} label="answers given" accent />
          <Metric icon={<LayersGlyph />} value={c.sourcesCount} label="sources surfaced" />
          {dur !== null ? <Metric icon={<ClockGlyph />} value={`${String(dur)}m`} label="duration" /> : null}
        </div>
        <SpeakerAvatars speakers={c.speakers} />
      </div>
    </a>
  );
}

function summaryLine(c: CaptureCard): string {
  if (c.status === 'failed') {
    return c.errorMessage ?? (c.errorCode !== null ? `Failed: ${c.errorCode}` : 'The bot could not record this meeting.');
  }
  if (c.summary !== null && c.summary.length > 0) return firstLine(c.summary);
  if (c.recapStatus === 'generating') return 'Generating the meeting recap…';
  return 'No recap was generated for this meeting.';
}

/** First sentence/line of the recap markdown, stripped of leading markup. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').trim())
    .find((l) => l.length > 0);
  return line ?? text.trim();
}

function Metric({
  icon,
  value,
  label,
  accent = false,
}: {
  icon: ReactElement;
  value: number | string;
  label: string;
  accent?: boolean;
}): ReactElement {
  return (
    <span
      title={label}
      aria-label={`${String(value)} ${label}`}
      className={`inline-flex items-center gap-1 tabular-nums ${accent ? 'text-accent' : ''}`}
    >
      {icon}
      {value}
    </span>
  );
}

/**
 * Only renders for the `failed` state — a badge that's on every card carries no
 * information. "Check" (amber) appears precisely when a recording needs
 * attention; a successful capture is the unremarkable default, so it gets none.
 */
function StatusBadge({ status }: { status: 'completed' | 'failed' }): ReactElement | null {
  if (status !== 'failed') return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-500">
      <WarnGlyph />
      Check
    </span>
  );
}

/**
 * Per-meeting visibility badge (permissions overhaul U6). The library now shows
 * org-visible meetings (RLS widened in U3), so each card surfaces who can see it.
 * Compact labels here (the full "(workspace)" qualifier lives on the picker);
 * the icon differentiates the three levels at a glance.
 */
const PRIVACY_BADGE: Record<PrivacyLevel, { short: string; className: string }> = {
  only_me: { short: 'Only me', className: 'bg-rose-500/15 text-rose-500' },
  only_participants: { short: 'Participants', className: 'bg-amber-500/15 text-amber-500' },
  only_teammates: { short: 'Workspace', className: 'bg-emerald-500/15 text-emerald-500' },
};

function PrivacyBadge({ level }: { level: PrivacyLevel }): ReactElement {
  const cfg = PRIVACY_BADGE[level];
  return (
    <span
      title={PRIVACY_LABEL[level]}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cfg.className}`}
    >
      <LockGlyph />
      {cfg.short}
    </span>
  );
}

function LockGlyph(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

const PLATFORM_STYLE: Record<CapturePlatform, string> = {
  zoom: 'bg-blue-500/15 text-blue-400',
  meet: 'bg-emerald-500/15 text-emerald-400',
  teams: 'bg-indigo-500/15 text-indigo-400',
  other: 'bg-slate-500/15 text-slate-400',
};

const PLATFORM_LABEL: Record<CapturePlatform, string> = {
  zoom: 'Zoom',
  meet: 'Meet',
  teams: 'Teams',
  other: 'Call',
};

const PLATFORM_TEXT: Record<CapturePlatform, string> = {
  zoom: 'text-blue-600 dark:text-blue-400',
  meet: 'text-emerald-600 dark:text-emerald-400',
  teams: 'text-indigo-600 dark:text-indigo-400',
  other: 'text-muted',
};

function PlatformIcon({ platform }: { platform: CapturePlatform }): ReactElement {
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${PLATFORM_STYLE[platform]}`}
      title={platform}
      aria-hidden="true"
    >
      <VideoGlyph />
    </span>
  );
}

const AVATAR_COLORS = [
  'bg-rose-500/80',
  'bg-amber-500/80',
  'bg-emerald-500/80',
  'bg-sky-500/80',
  'bg-violet-500/80',
  'bg-fuchsia-500/80',
  'bg-teal-500/80',
  'bg-indigo-500/80',
];

function SpeakerAvatars({ speakers }: { speakers: string[] }): ReactElement | null {
  if (speakers.length === 0) return null;
  const shown = speakers.slice(0, 3);
  const extra = speakers.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5" title={speakers.join(', ')}>
      {shown.map((name, i) => (
        <span
          key={`${name}-${String(i)}`}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full border border-card text-[10px] font-semibold text-white ${AVATAR_COLORS[colorIndex(name)]}`}
        >
          {initial(name)}
        </span>
      ))}
      {extra > 0 ? (
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-card bg-card text-[10px] font-semibold text-muted">
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

function initial(name: string): string {
  const t = name.trim();
  return t.length > 0 ? t[0]!.toUpperCase() : '?';
}

function colorIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % AVATAR_COLORS.length;
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
      <h2 className="text-lg font-semibold tracking-tight">No captures yet</h2>
      <p className="mx-auto mt-2 max-w-sm text-pretty text-sm text-muted">
        Meetings the Risezome bot attended appear here once they wrap — your workspace’s shared
        library, plus any private meetings you can see. Toggle the bot on for a meeting on the{' '}
        <a href="/upcoming" className="text-accent hover:underline">
          Upcoming
        </a>{' '}
        page to get started.
      </p>
    </div>
  );
}

// ── pure helpers ──────────────────────────────────────────────────────────

function durationMin(c: CaptureCard): number | null {
  if (c.startedAtIso === null || c.endedAtIso === null) return null;
  const m = Math.round((new Date(c.endedAtIso).getTime() - new Date(c.startedAtIso).getTime()) / 60_000);
  return m >= 0 ? m : null;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function groupByDay(items: CaptureCard[]): Array<{ dayKey: string; day: string; items: CaptureCard[] }> {
  const groups = new Map<string, CaptureCard[]>();
  for (const c of items) {
    const ts = c.startedAtIso ?? c.endedAtIso ?? c.createdAtIso;
    const key = new Date(ts).toDateString();
    const bucket = groups.get(key) ?? [];
    bucket.push(c);
    groups.set(key, bucket);
  }
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();
  return Array.from(groups.entries()).map(([dayKey, list]) => {
    let day: string;
    if (dayKey === today) day = 'Today';
    else if (dayKey === yesterday) day = 'Yesterday';
    else
      day = new Date(dayKey).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });
    return { dayKey, day, items: list };
  });
}

// ── glyphs ────────────────────────────────────────────────────────────────

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

function ChevronDown(): ReactElement {
  return (
    <svg
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function VideoGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M22 8l-5 4 5 4z" />
    </svg>
  );
}

function SparkleGlyph(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l1.7 4.5L18 9l-4.3 1.5L12 15l-1.7-4.5L6 9l4.3-1.5z" />
    </svg>
  );
}

function LayersGlyph(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

function ClockGlyph(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function WarnGlyph(): ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17.5v.01" />
    </svg>
  );
}
