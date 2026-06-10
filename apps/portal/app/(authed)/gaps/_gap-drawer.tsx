'use client';

import { useEffect, useState, useTransition, type ReactElement } from 'react';
import type { GapOccurrenceView, GapView, OrgMember, SectionView } from './_types';
import {
  Avatar,
  ChevronDown,
  CloseGlyph,
  FlameGlyph,
  QuestionGlyph,
  SectionDot,
  StatusPill,
  VideoGlyph,
  relativeTime,
  shortDate,
} from './_bits';
import {
  assignGapAction,
  dismissGapAction,
  listGapOccurrencesAction,
  resolveGapAction,
  shareWithOrgAction,
} from './gap-actions';
import { moveGapToSectionAction } from './section-actions';
import { Drawer, useMenuBehaviors } from '../_components/overlay';

/**
 * Gap detail drawer (plan U10 / mockup #8). Right-side slide-over. Optimistic
 * actions via useTransition with rollback on a non-ok result. resolve/dismiss
 * are open to assignee-or-manager (server enforces); assign/share/move-section
 * are manager-only (the controls are hidden for members).
 */
export function GapDrawer({
  gap,
  sections,
  members,
  isManager,
  now,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: {
  gap: GapView;
  sections: SectionView[];
  members: OrgMember[];
  isManager: boolean;
  now: number | null;
  /** Whether a previous/next gap exists in the list the drawer was opened from
   *  — drives the ↑/↓ header buttons (disabled at the ends). */
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}): ReactElement {
  const [status, setStatus] = useState(gap.status);
  const [assigneeId, setAssigneeId] = useState(gap.assigneeId);
  const [assigneeName, setAssigneeName] = useState(gap.assigneeName);
  const [sectionId, setSectionId] = useState(gap.sectionId);
  const [shared, setShared] = useState(gap.sharedWithOrg);
  const [error, setError] = useState<string | null>(null);
  // `pending` dims the action row while a server action is in flight, so a
  // slow/failing call reads as "working" instead of a silent flicker-rollback.
  const [pending, start] = useTransition();

  // Occurrences are lazy-loaded on open (the page no longer bulk-fetches them).
  // Seed from gap.occurrences so callers that already have them (tests, future
  // prefetch) skip the round trip. Gated viewers never fetch — the RLS-scoped
  // action would return [] anyway; this just skips the no-op call.
  const [occurrences, setOccurrences] = useState<GapOccurrenceView[]>(gap.occurrences);
  const [occState, setOccState] = useState<'idle' | 'loading' | 'error'>(
    gap.canViewContent && gap.occurrences.length === 0 ? 'loading' : 'idle',
  );
  useEffect(() => {
    if (!gap.canViewContent || gap.occurrences.length > 0) return;
    let cancelled = false;
    // Server actions REJECT (rather than returning {ok:false}) on network
    // failure and on deployment skew (action id changed under an open page) —
    // without the catch the drawer showed "Loading moments…" forever.
    listGapOccurrencesAction(gap.gapId)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setOccurrences(r.occurrences);
          setOccState('idle');
        } else {
          setOccState('error');
        }
      })
      .catch(() => {
        if (!cancelled) setOccState('error');
      });
    return () => {
      cancelled = true;
    };
    // Keyed on length (not array identity): a revalidatePath after a drawer
    // action ships a fresh-but-still-empty occurrences prop; identity-keying
    // would refetch data we already hold after every action.
  }, [gap.gapId, gap.canViewContent, gap.occurrences.length]);

  const section = sections.find((s) => s.sectionId === sectionId) ?? null;
  const phrasings = distinctPhrasings(gap.title, occurrences);

  function onResolve(): void {
    const prev = status;
    setStatus('resolved');
    setError(null);
    start(async () => {
      const r = await resolveGapAction(gap.gapId);
      if (!r.ok) {
        setStatus(prev);
        setError(friendly(r.error));
      }
    });
  }

  function onDismiss(): void {
    const prev = status;
    setStatus('dismissed');
    setError(null);
    start(async () => {
      const r = await dismissGapAction(gap.gapId);
      if (!r.ok) {
        setStatus(prev);
        setError(friendly(r.error));
      }
    });
  }

  function onShare(): void {
    setShared(true);
    setError(null);
    start(async () => {
      const r = await shareWithOrgAction(gap.gapId);
      if (!r.ok) {
        setShared(false);
        setError(friendly(r.error));
      }
    });
  }

  function onAssign(userId: string): void {
    const prevId = assigneeId;
    const prevName = assigneeName;
    const prevStatus = status;
    const member = members.find((m) => m.userId === userId) ?? null;
    setAssigneeId(userId);
    setAssigneeName(member?.name ?? null);
    if (status !== 'open') setStatus('open');
    setError(null);
    start(async () => {
      const r = await assignGapAction(gap.gapId, userId);
      if (!r.ok) {
        setAssigneeId(prevId);
        setAssigneeName(prevName);
        setStatus(prevStatus);
        setError(friendly(r.error));
      }
    });
  }

  function onMoveSection(nextSectionId: string | null): void {
    const prev = sectionId;
    setSectionId(nextSectionId);
    setError(null);
    start(async () => {
      const r = await moveGapToSectionAction(gap.gapId, nextSectionId);
      if (!r.ok) {
        setSectionId(prev);
        setError(friendly(r.error));
      }
    });
  }

  // J/K (and ArrowUp/ArrowDown outside form controls) walk the drawer's list —
  // the keyboard mirror of the ↑/↓ header buttons. Guarded so typing in an
  // input/select never triggers navigation, and arrows keep their native
  // meaning inside form controls.
  function onDrawerKeyDown(e: KeyboardEvent): void {
    const t = e.target;
    const inFormControl =
      t instanceof HTMLElement && (t.closest('input, select, textarea') !== null || t.isContentEditable);
    if (inFormControl) return;
    if (e.key === 'j' || (e.key === 'ArrowDown' && e.altKey)) {
      if (hasNext) onNext();
    } else if (e.key === 'k' || (e.key === 'ArrowUp' && e.altKey)) {
      if (hasPrev) onPrev();
    }
  }

  return (
    <Drawer onClose={onClose} ariaLabel={`Gap details: ${gap.title}`} onKeyDown={onDrawerKeyDown}>
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            {isManager ? (
              <SectionSelect sections={sections} value={sectionId} onChange={onMoveSection} />
            ) : section !== null ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted">
                <SectionDot color={section.color} />
                {section.name}
              </span>
            ) : (
              <span className="text-sm text-muted">Uncategorized</span>
            )}
            <StatusPill status={status} />
          </div>
          <div className="flex flex-none items-center gap-1.5">
            {/* Prev/next walk the list the drawer was opened from; the slide-over
                stays open and swaps content. Disabled at the ends. */}
            <div className="flex items-center rounded-lg border border-border">
              <button
                type="button"
                aria-label="Previous gap"
                title="Previous gap (K)"
                onClick={onPrev}
                disabled={!hasPrev}
                className="flex h-8 w-8 items-center justify-center rounded-l-lg text-muted transition-colors hover:bg-card hover:text-fg disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowUpGlyph />
              </button>
              <span className="h-5 w-px bg-border" aria-hidden="true" />
              <button
                type="button"
                aria-label="Next gap"
                title="Next gap (J)"
                onClick={onNext}
                disabled={!hasNext}
                className="flex h-8 w-8 items-center justify-center rounded-r-lg text-muted transition-colors hover:bg-card hover:text-fg disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowDownGlyph />
              </button>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-card hover:text-fg"
            >
              <CloseGlyph />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-6 px-5 py-5">
          {/* title */}
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex-none text-accent">
              <QuestionGlyph />
            </span>
            <h2 className="text-balance text-xl font-semibold leading-snug tracking-tight">{gap.title}</h2>
          </div>

          {/* action row */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onResolve}
              disabled={pending || status === 'resolved'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3.5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <CheckGlyph />
              Mark resolved
            </button>
            <button
              type="button"
              onClick={onDismiss}
              disabled={pending || status === 'dismissed'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 disabled:opacity-50"
            >
              <CloseGlyph />
              Dismiss
            </button>
            {isManager ? (
              <button
                type="button"
                onClick={onShare}
                disabled={pending || shared}
                title={shared ? 'Shared with the whole org' : 'Share with the whole org'}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted transition-colors hover:border-accent/40 hover:text-fg disabled:opacity-50"
              >
                <ShareGlyph />
              </button>
            ) : null}
          </div>
          {shared ? <p className="-mt-3 text-xs text-muted">Shared with the whole org.</p> : null}
          {error !== null ? (
            <p role="alert" className="-mt-3 text-sm text-error">
              {error}
            </p>
          ) : null}

          {/* owner */}
          <Block label="Owner">
            {assigneeId !== null ? (
              <div className="flex items-center gap-2">
                <Avatar name={assigneeName ?? '?'} size={7} />
                <span className="text-sm font-medium text-fg">{assigneeName ?? 'Member'}</span>
                {isManager ? <AssigneePicker members={members} onAssign={onAssign} label="Change" /> : null}
              </div>
            ) : isManager ? (
              <AssigneePicker members={members} onAssign={onAssign} label="Assign owner" />
            ) : (
              <span className="text-sm text-muted">Unassigned</span>
            )}
          </Block>

          {/* demand */}
          <Block label="Demand">
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1 font-semibold text-orange-600 dark:text-orange-400">
                <FlameGlyph />
                {gap.frequency}×
              </span>
              <span className="text-muted">
                {gap.people} {gap.people === 1 ? 'person' : 'people'} · {gap.meetings}{' '}
                {gap.meetings === 1 ? 'meeting' : 'meetings'}
              </span>
            </div>
          </Block>

          {/* CONTENT tier (verbatim paraphrases + captured moments) — gated to
              meeting participants. An outsider-assignee or org-wide-share viewer
              (canViewContent=false) sees the gap ROW above but not the room's
              verbatim; the occurrence list comes back empty under RLS anyway, and
              we never render the "Open moment" deep-link for them. */}
          {gap.canViewContent ? (
            <>
              {/* merged phrasings */}
              {phrasings.length > 0 ? (
                <Block label={`Merged phrasings · ${String(phrasings.length)}`}>
                  <ul className="flex flex-col gap-1.5">
                    {phrasings.map((p, i) => (
                      <li key={`${p}-${String(i)}`} className="border-l-2 border-border pl-3 text-sm italic text-muted">
                        “{p}”
                      </li>
                    ))}
                  </ul>
                </Block>
              ) : null}

              {/* moments — count falls back to the fetched list when the stats
                  RPC degraded to zeros (the list itself is RLS-authoritative). */}
              <Block
                label={`Where it was asked · ${String(Math.max(gap.moments, occurrences.length))} ${
                  Math.max(gap.moments, occurrences.length) === 1 ? 'moment' : 'moments'
                }`}
              >
                {occState === 'loading' ? (
                  <p className="text-sm text-muted">Loading moments…</p>
                ) : occState === 'error' ? (
                  <p className="text-sm text-error">
                    Couldn&apos;t load the moments — close and reopen the gap to retry.
                  </p>
                ) : (
                <ul className="flex flex-col gap-4">
                  {occurrences.map((o) => (
                    <li key={o.occurrenceId} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <Avatar name={o.askerName} size={6} />
                        <span className="text-sm font-medium text-fg">{o.askerName}</span>
                        <span className="text-xs text-muted">{shortDate(o.askedAtIso)}</span>
                      </div>
                      <p className="border-l-2 border-border pl-3 text-sm italic text-muted">“{o.verbatimQuestion}”</p>
                      <div className="flex items-center justify-between gap-2 pl-3">
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                          <VideoGlyph />
                          {o.meetingTitle.length > 0 ? o.meetingTitle : 'Untitled meeting'}
                        </span>
                        <a
                          href={momentHref(o.meetingId, o.utteranceId)}
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          Open moment →
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
                )}
              </Block>
            </>
          ) : (
            <p className="rounded-lg border border-border bg-card/40 px-3.5 py-3 text-sm leading-relaxed text-muted">
              You’re assigned this question but weren’t in the original meeting, so the paraphrases and the
              captured moment are hidden.
            </p>
          )}

          {/* audit footer */}
          <p className="border-t border-border pt-4 text-xs leading-relaxed text-faint">
            Captured automatically
            {gap.firstAskedAtIso !== null ? ` · first asked ${shortDate(gap.firstAskedAtIso)}` : ''}
            {assigneeId !== null && assigneeName !== null
              ? ` · assigned to ${assigneeName}${gap.assignedByName !== null ? ` by ${gap.assignedByName}` : ''}${
                  gap.assignedAtIso !== null && now !== null ? ` ${relativeTime(gap.assignedAtIso, now)}` : ''
                }`
              : ''}
          </p>
        </div>
    </Drawer>
  );
}

/** Deep-link to the meeting review page anchored at the utterance (R20). The
 *  review page doesn't yet render DOM anchors for utterances, so the hash is a
 *  forward-compatible no-op today — the page still loads correctly. */
function momentHref(meetingId: string, utteranceId: string | null): string {
  const base = `/meetings/${meetingId}/review`;
  return utteranceId !== null ? `${base}#utterance-${utteranceId}` : base;
}

function distinctPhrasings(title: string, occurrences: GapOccurrenceView[]): string[] {
  const seen = new Set<string>([title]);
  const out: string[] = [];
  for (const o of occurrences) {
    if (!seen.has(o.verbatimQuestion)) {
      seen.add(o.verbatimQuestion);
      out.push(o.verbatimQuestion);
    }
  }
  return out;
}

function friendly(error: string): string {
  if (error === 'forbidden') return 'You don’t have permission to do that.';
  if (error === 'not_found') return 'This gap no longer exists.';
  return error;
}

function Block({ label, children }: { label: string; children: ReactElement | ReactElement[] | string }): ReactElement {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</h3>
      {children}
    </section>
  );
}

function SectionSelect({
  sections,
  value,
  onChange,
}: {
  sections: SectionView[];
  value: string | null;
  onChange: (id: string | null) => void;
}): ReactElement {
  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pl-3 pr-7 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none"
      >
        <option value="">Uncategorized</option>
        {sections.map((s) => (
          <option key={s.sectionId} value={s.sectionId}>
            {s.name}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

function AssigneePicker({
  members,
  onAssign,
  label,
}: {
  members: OrgMember[];
  onAssign: (userId: string) => void;
  label: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  useMenuBehaviors(open, () => setOpen(false));
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-accent/40"
      >
        {label}
        <ChevronDown />
      </button>
      {open ? (
        <>
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-8 z-20 max-h-64 w-52 overflow-auto rounded-lg border border-border bg-card py-1 shadow-[var(--shadow-pop)]">
            {members.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAssign(m.userId);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-accent-soft/50"
              >
                <Avatar name={m.name} size={5} />
                <span className="truncate">{m.name}</span>
              </button>
            ))}
            {members.length === 0 ? <p className="px-3 py-1.5 text-xs text-muted">No members</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ArrowUpGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function ArrowDownGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

function CheckGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  );
}

function ShareGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" />
    </svg>
  );
}
