'use client';

import { useState, type ReactElement } from 'react';
import type { GapView, OrgMember } from './_types';
import {
  Avatar,
  ChevronDown,
  ClockGlyph,
  DemandBar,
  DotsGlyph,
  MomentsGlyph,
  PersonGlyph,
  StatusPill,
  VideoGlyph,
  demandTier,
  relativeTime,
} from './_bits';

/**
 * A single gap row (plan U8). Left: demand number + tiered sparkline. Center:
 * title + "+N phrasings" pill + meta (people / meetings / relative last-asked /
 * "N moments" → opens the drawer). Right: status pill + owner avatar or Assign
 * button + ⋮ overflow menu.
 */
export function GapRow({
  gap,
  members,
  isManager,
  now,
  onOpen,
  onAssign,
  onMerge,
  onMoveSection,
}: {
  gap: GapView;
  members: OrgMember[];
  isManager: boolean;
  now: number | null;
  onOpen: () => void;
  onAssign: (assigneeUserId: string) => void;
  onMerge: () => void;
  onMoveSection: () => void;
}): ReactElement {
  const tier = demandTier(gap.frequency);
  const lastAsked =
    gap.lastAskedAtIso !== null && now !== null ? relativeTime(gap.lastAskedAtIso, now) : null;

  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:rounded-b-2xl last:border-b-0 hover:bg-card/40">
      {/* demand */}
      <div className="flex w-10 flex-none flex-col items-center">
        <span className={`text-lg font-bold tabular-nums ${tier.text}`}>{gap.frequency}×</span>
        <DemandBar frequency={gap.frequency} />
      </div>

      {/* center */}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-fg">{gap.title}</span>
          {/* "+N phrasings" is content-derived (reads 0 for non-content viewers
              under the tightened gap_occurrences RLS) — hide it for them. */}
          {gap.canViewContent && gap.extraPhrasings > 0 ? (
            <span className="flex-none rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
              +{gap.extraPhrasings} phrasings
            </span>
          ) : null}
          {gap.reopenedAfterClose && gap.status === 'open' ? (
            <span className="flex-none rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              Re-asked
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
          {/* people / meetings / moments are content-derived aggregates (0 for
              non-content viewers) — drop them; keep the row-level last-asked. */}
          {gap.canViewContent ? (
            <>
              <span
                className="inline-flex items-center gap-1"
                title="People who asked"
                aria-label={`${gap.people} ${gap.people === 1 ? 'person' : 'people'} asked`}
              >
                <PersonGlyph />
                {gap.people}
              </span>
              <span
                className="inline-flex items-center gap-1"
                title="Meetings where this came up"
                aria-label={`${gap.meetings} ${gap.meetings === 1 ? 'meeting' : 'meetings'}`}
              >
                <VideoGlyph />
                {gap.meetings}
              </span>
            </>
          ) : null}
          {lastAsked !== null ? (
            <span className="inline-flex items-center gap-1" title="Last asked">
              <ClockGlyph />
              {lastAsked}
            </span>
          ) : null}
          {gap.canViewContent ? (
            <span
              className="inline-flex items-center gap-1 text-accent"
              title="Conversation moments — open to view"
            >
              <MomentsGlyph />
              {gap.moments} {gap.moments === 1 ? 'moment' : 'moments'}
            </span>
          ) : null}
        </div>
      </button>

      {/* right */}
      <div className="flex flex-none items-center gap-2.5">
        <StatusPill status={gap.status} />
        {gap.assigneeId !== null ? (
          <Avatar name={gap.assigneeName ?? '?'} size={7} />
        ) : isManager ? (
          <AssignButton members={members} onAssign={onAssign} />
        ) : (
          <span className="text-xs text-muted">Unassigned</span>
        )}
        <OverflowMenu
          isManager={isManager}
          onOpen={onOpen}
          onMerge={onMerge}
          onMoveSection={onMoveSection}
        />
      </div>
    </div>
  );
}

function AssignButton({
  members,
  onAssign,
}: {
  members: OrgMember[];
  onAssign: (assigneeUserId: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-accent/40"
      >
        Assign
        <ChevronDown />
      </button>
      {open ? (
        <>
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-20 max-h-64 w-52 overflow-auto rounded-lg border border-border bg-card py-1 shadow-lg">
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

function OverflowMenu({
  isManager,
  onOpen,
  onMerge,
  onMoveSection,
}: {
  isManager: boolean;
  onOpen: () => void;
  onMerge: () => void;
  onMoveSection: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex justify-end">
      <button
        type="button"
        aria-label="Gap actions"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card hover:text-fg"
      >
        <DotsGlyph />
      </button>
      {open ? (
        <>
          <button type="button" aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-20 w-48 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpen();
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-accent-soft/50"
            >
              Open details
            </button>
            {isManager ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onMoveSection();
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-accent-soft/50"
                >
                  Move to section…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onMerge();
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-accent-soft/50"
                >
                  Merge with another gap…
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
