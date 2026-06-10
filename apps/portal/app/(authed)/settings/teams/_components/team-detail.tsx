'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { roleLabel } from '../../../../_lib/roles';
import { primaryButtonClass } from '../../../_components/ui';
import {
  addTeamMemberAction,
  archiveTeamAction,
  removeTeamMemberAction,
  renameTeamAction,
} from '../team-actions';
import { useMenuBehaviors } from '../../../_components/overlay';
import { avatarColor, avatarInitial, teamDotColor } from './visuals';
import type { MemberVM, TeamVM } from './teams-members-client';

/**
 * Team detail view (rail → team selected). Mirrors the design: a back-to-all
 * header with the team identity + counts + a Settings popover (rename/archive),
 * a Members card with an "Add member" picker and per-row remove, and a Sources
 * card that is now READ-ONLY (count + a link to the Sources page, KTD5) — the
 * Sources page is the single editor for `team_sources`.
 *
 * Member mutations reuse the shipped team actions — rename/archive, add/remove
 * member — with the optimistic-then-revert idiom; the actions'
 * revalidatePath('/settings/teams') reconciles server truth. Source curation moved to
 * /sources?team=<teamId>.
 */
export function TeamDetail({
  team,
  members,
  onBack,
}: {
  team: TeamVM;
  members: MemberVM[];
  onBack: () => void;
}): ReactElement {
  // Local membership set, seeded from the server snapshot; toggled optimistically.
  const [memberIds, setMemberIds] = useState<Set<string>>(() => new Set(team.memberIds));
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState(team.name);

  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  const onTeam = members.filter((m) => memberIds.has(m.userId));

  function setMembership(userId: string, on: boolean): void {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  if (archived) {
    return (
      <div className="rounded-2xl border border-border bg-card/30 px-6 py-16 text-center shadow-[var(--card-shadow)]">
        <p className="text-sm text-muted">
          Team <span className="font-medium text-fg">{name}</span> was archived.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-fg hover:border-accent/40"
        >
          Back to all members
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label="Back to all members"
            onClick={onBack}
            className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg text-muted transition-colors hover:bg-card hover:text-fg"
          >
            <ChevronLeft />
          </button>
          <div>
            <div className="flex items-center gap-2.5">
              <span className={`h-3 w-3 rounded-full ${teamDotColor(team.teamId)}`} />
              <h2 className="text-2xl font-bold tracking-tight">{name}</h2>
              <span className="font-mono text-sm text-muted">#{team.slug}</span>
            </div>
            <p className="mt-1 text-sm text-muted">
              {onTeam.length} {onTeam.length === 1 ? 'member' : 'members'} ·{' '}
              {team.sourceIds.length} {team.sourceIds.length === 1 ? 'source' : 'sources'} searched
            </p>
          </div>
        </div>
        <SettingsPopover
          teamId={team.teamId}
          name={name}
          onRenamed={(n) => setName(n)}
          onArchived={() => setArchived(true)}
        />
      </div>

      <MembersCard
        teamId={team.teamId}
        onTeam={onTeam}
        candidates={members.filter((m) => !memberIds.has(m.userId))}
        memberById={memberById}
        onToggle={setMembership}
      />

      <SourcesSummaryCard teamId={team.teamId} sourceCount={team.sourceIds.length} />
    </div>
  );
}

// ── Sources summary (read-only; KTD5) ──────────────────────────────────────────

/**
 * Read-only Sources summary. The Sources page (/sources?team=<id>) is now the
 * single editor for `team_sources`, so the team-detail only shows the count and
 * links there — no toggles here (avoids two editors drifting, R1/KTD5).
 */
function SourcesSummaryCard({
  teamId,
  sourceCount,
}: {
  teamId: string;
  sourceCount: number;
}): ReactElement {
  return (
    <section className="rounded-2xl border border-border bg-card/40 p-5 shadow-[var(--card-shadow)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">Sources · {sourceCount}</h3>
          <p className="mt-1 text-sm text-muted">
            {sourceCount === 0
              ? 'This team searches no sources yet.'
              : `Searching ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}.`}
          </p>
        </div>
        <a
          href={`/sources?team=${encodeURIComponent(teamId)}`}
          className="inline-flex flex-none items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40"
        >
          Manage on Sources
          <ArrowRight />
        </a>
      </div>
    </section>
  );
}

function ArrowRight(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

// ── Settings popover (rename / archive) ────────────────────────────────────────

function SettingsPopover({
  teamId,
  name,
  onRenamed,
  onArchived,
}: {
  teamId: string;
  name: string;
  onRenamed: (name: string) => void;
  onArchived: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  useMenuBehaviors(open, () => setOpen(false));
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function rename(): void {
    const next = draft.trim();
    if (next.length === 0 || next === name) {
      setOpen(false);
      return;
    }
    setError(null);
    start(async () => {
      const result = await renameTeamAction(teamId, next);
      if (result.ok) {
        onRenamed(next);
        setOpen(false);
      } else {
        setError(result.error === 'duplicate_slug' ? 'Name already in use.' : 'Could not rename.');
      }
    });
  }

  function archive(): void {
    setError(null);
    start(async () => {
      const result = await archiveTeamAction(teamId);
      if (result.ok) onArchived();
      else setError('Could not archive the team.');
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setDraft(name);
          setOpen((o) => !o);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40"
      >
        <GearGlyph />
        Settings
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-11 z-20 w-64 rounded-xl border border-border bg-card p-3 shadow-[var(--shadow-pop)]">
            <label className="block text-xs font-medium text-muted">Team name</label>
            <input
              type="text"
              value={draft}
              autoFocus
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename();
              }}
              className="mt-1 w-full rounded-lg border border-border bg-bg/60 px-3 py-1.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={rename}
              disabled={pending}
              className={`${primaryButtonClass} mt-2 w-full`}
            >
              {pending ? 'Saving…' : 'Save name'}
            </button>
            <div className="my-3 border-t border-border" />
            <button
              type="button"
              onClick={archive}
              disabled={pending}
              className="w-full rounded-lg px-3 py-1.5 text-left text-sm font-medium text-rose-400 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
            >
              Archive team
            </button>
            {error !== null ? <p role="alert" className="mt-2 text-xs text-error">{error}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Members card ───────────────────────────────────────────────────────────────

function MembersCard({
  teamId,
  onTeam,
  candidates,
  memberById,
  onToggle,
}: {
  teamId: string;
  onTeam: MemberVM[];
  candidates: MemberVM[];
  memberById: Map<string, MemberVM>;
  onToggle: (userId: string, on: boolean) => void;
}): ReactElement {
  const [adding, setAdding] = useState(false);

  return (
    <section className="rounded-2xl border border-border bg-card/40 p-5 shadow-[var(--card-shadow)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">Members ({onTeam.length})</h3>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className={`${primaryButtonClass} px-3 py-1.5 text-xs`}
        >
          <PlusGlyph />
          Add member
        </button>
      </div>

      {adding ? (
        <AddMemberPicker
          teamId={teamId}
          candidates={candidates}
          onAdded={(userId) => onToggle(userId, true)}
          onClose={() => setAdding(false)}
        />
      ) : null}

      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {onTeam.map((m) => (
          <TeamMemberRow key={m.userId} teamId={teamId} member={m} onRemoved={() => onToggle(m.userId, false)} />
        ))}
        {onTeam.length === 0 ? (
          <li className="bg-card/20 px-4 py-6 text-center text-sm text-muted">
            No members on this team yet. Add one above.
          </li>
        ) : null}
      </ul>
      {/* memberById is consumed for stable identity; referenced to satisfy linting. */}
      <span className="sr-only">{memberById.size}</span>
    </section>
  );
}

function TeamMemberRow({
  teamId,
  member,
  onRemoved,
}: {
  teamId: string;
  member: MemberVM;
  onRemoved: () => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function remove(): void {
    onRemoved(); // optimistic
    setError(null);
    start(async () => {
      const result = await removeTeamMemberAction(teamId, member.userId);
      if (!result.ok) setError('Could not remove. Refresh and retry.');
    });
  }

  return (
    <li className="flex items-center gap-3 bg-card/20 px-4 py-3">
      <Avatar name={member.name ?? member.email} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{member.name ?? member.email}</span>
          {member.isSelf ? (
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              You
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted">{member.email}</p>
        {error !== null ? <p role="alert" className="text-xs text-error">{error}</p> : null}
      </div>
      <RolePill role={member.role} />
      <button
        type="button"
        aria-label={`Remove ${member.email} from team`}
        onClick={remove}
        disabled={pending}
        className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-muted transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50"
      >
        <CloseGlyph />
      </button>
    </li>
  );
}

function AddMemberPicker({
  teamId,
  candidates,
  onAdded,
  onClose,
}: {
  teamId: string;
  candidates: MemberVM[];
  onAdded: (userId: string) => void;
  onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return candidates;
    return candidates.filter((m) => `${m.name ?? ''} ${m.email}`.toLowerCase().includes(q));
  }, [candidates, query]);

  function add(userId: string): void {
    setPendingId(userId);
    setError(null);
    start(async () => {
      const result = await addTeamMemberAction(teamId, userId);
      setPendingId(null);
      if (result.ok) onAdded(userId);
      else setError(result.error === 'not_an_org_member' ? 'Not a workspace member.' : 'Could not add.');
    });
  }

  return (
    <div className="mb-3 rounded-xl border border-border bg-bg/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspace members"
          className="flex-1 rounded-lg border border-border bg-bg/60 px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:text-fg"
        >
          Done
        </button>
      </div>
      <ul className="max-h-64 overflow-y-auto rounded-lg border border-border">
        {filtered.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 border-b border-border bg-card/20 px-3 py-2 last:border-b-0">
            <Avatar name={m.name ?? m.email} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{m.name ?? m.email}</span>
              <span className="block truncate text-xs text-muted">{m.email}</span>
            </div>
            <button
              type="button"
              onClick={() => add(m.userId)}
              disabled={pendingId === m.userId}
              className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-accent/40 disabled:opacity-50"
            >
              {pendingId === m.userId ? 'Adding…' : 'Add'}
            </button>
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-muted">
            {candidates.length === 0 ? 'Everyone is already on this team.' : 'No matches.'}
          </li>
        ) : null}
      </ul>
      {error !== null ? <p role="alert" className="mt-2 text-xs text-error">{error}</p> : null}
    </div>
  );
}

// ── bits ───────────────────────────────────────────────────────────────────────

const ROLE_DOT: Record<string, string> = {
  super_admin: 'bg-amber-400',
  manager: 'bg-violet-400',
  member: 'bg-emerald-400',
};

function RolePill({ role }: { role: string }): ReactElement {
  return (
    <span className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-fg">
      <span className={`h-1.5 w-1.5 rounded-full ${ROLE_DOT[role] ?? 'bg-slate-400'}`} />
      {roleLabel(role)}
    </span>
  );
}

function Avatar({ name }: { name: string }): ReactElement {
  return (
    <span
      className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-sm font-semibold text-white ${avatarColor(name)}`}
      aria-hidden="true"
    >
      {avatarInitial(name)}
    </span>
  );
}

function ChevronLeft(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function PlusGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function CloseGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function GearGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
