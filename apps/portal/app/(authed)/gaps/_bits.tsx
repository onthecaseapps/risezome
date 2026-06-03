'use client';

import { useState, useTransition, type ReactElement } from 'react';
import type { GapStatus } from './_types';
import { requestGapsBackfillAction } from './gap-actions';

/** Manager-only one-off: rebuild the library from past meetings' retracted syntheses. */
export function BackfillButton(): ReactElement {
  const [pending, start] = useTransition();
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');

  if (state === 'done') {
    return (
      <p className="text-sm text-accent">
        Backfill started — gaps from past meetings will appear here in a few minutes.
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          start(async () => {
            const res = await requestGapsBackfillAction();
            setState(res.ok ? 'done' : 'error');
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 disabled:opacity-60"
      >
        {pending ? 'Starting backfill…' : 'Backfill from past meetings'}
      </button>
      {state === 'error' ? (
        <p className="mt-2 text-xs text-error">Couldn&apos;t start the backfill — try again.</p>
      ) : null}
    </div>
  );
}

// ── demand tiering (presentational only) ────────────────────────────────────

/** Tier a frequency into a colour band for the row sparkline / demand number.
 *  Purely presentational — high ≥7 orange, mid 3–6 violet, low ≤2 gray. */
export function demandTier(frequency: number): { text: string; bar: string } {
  if (frequency >= 7) return { text: 'text-orange-400', bar: 'bg-orange-400' };
  if (frequency >= 3) return { text: 'text-violet-400', bar: 'bg-violet-400' };
  return { text: 'text-slate-400', bar: 'bg-slate-400' };
}

/** A thin colored progress bar under the demand number (caps the fill at 10×). */
export function DemandBar({ frequency }: { frequency: number }): ReactElement {
  const tier = demandTier(frequency);
  const pct = Math.min(100, Math.max(8, (frequency / 10) * 100));
  return (
    <div className="mt-1 h-1 w-9 overflow-hidden rounded-full bg-border">
      <div className={`h-full rounded-full ${tier.bar}`} style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

// ── status pill ─────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<GapStatus, string> = {
  open: 'bg-emerald-500/15 text-emerald-400',
  resolved: 'bg-sky-500/15 text-sky-400',
  dismissed: 'bg-slate-500/15 text-slate-400',
};
const STATUS_LABEL: Record<GapStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export function StatusPill({ status }: { status: GapStatus }): ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ── section color dot ───────────────────────────────────────────────────────

const SECTION_DOT: Record<string, string> = {
  indigo: 'bg-indigo-400',
  emerald: 'bg-emerald-400',
  sky: 'bg-sky-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  violet: 'bg-violet-400',
  teal: 'bg-teal-400',
  slate: 'bg-slate-400',
};

export function SectionDot({ color }: { color: string }): ReactElement {
  return <span className={`inline-block h-2 w-2 flex-none rounded-full ${SECTION_DOT[color] ?? 'bg-slate-400'}`} />;
}

// ── avatar ──────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-rose-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-fuchsia-500',
  'bg-teal-500',
  'bg-indigo-500',
];

export function Avatar({ name, size = 7 }: { name: string; size?: number }): ReactElement {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  const initial = name.trim().length > 0 ? name.trim()[0]!.toUpperCase() : '?';
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full text-[11px] font-semibold text-white ${color}`}
      style={{ height: `${String(size * 4)}px`, width: `${String(size * 4)}px` }}
      title={name}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

// ── time helpers ────────────────────────────────────────────────────────────

export function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${String(hr)}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${String(day)}d ago`;
  return shortDate(iso);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── glyphs ──────────────────────────────────────────────────────────────────

export function FlameGlyph({ className = '' }: { className?: string }): ReactElement {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c1 3-1.5 4.5-1.5 7A2.5 2.5 0 0 0 13 11c0-1.2 1-2 1-2 .8 1.4 3 2.6 3 5.5A5 5 0 1 1 7 14.5c0-2.4 1.5-3.8 2.3-5C10.4 8 12 6 12 2z" />
    </svg>
  );
}

export function PersonGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

export function VideoGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M22 8l-5 4 5 4z" />
    </svg>
  );
}

export function ClockGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function MomentsGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function DotsGlyph(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

export function CloseGlyph(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function ChevronDown({ className = '' }: { className?: string }): ReactElement {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function QuestionGlyph({ className = '' }: { className?: string }): ReactElement {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.9-2.6 2.4-2.6 4" />
      <path d="M12 17.5v.01" />
    </svg>
  );
}
