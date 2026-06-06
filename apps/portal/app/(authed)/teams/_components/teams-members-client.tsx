'use client';

import {
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactElement,
} from 'react';
import { roleLabel } from '../../../_lib/roles';
import { primaryButtonClass } from '../../_components/ui';
import { createInviteAction, revokeInviteAction } from '../../members/invite-action';
import {
  changeRoleAction,
  removeMemberAction,
} from '../../members/member-actions';
import { createTeamAction } from '../team-actions';
import { slugify } from '../_lib/team-validation';
import { avatarColor, avatarInitial, teamDotColor } from './visuals';
import { TeamDetail } from './team-detail';

// ── View models (assembled server-side in page.tsx) ──────────────────────────

export interface MemberVM {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  canInviteBot: boolean;
  isSelf: boolean;
  lastSignInAt: string | null;
  /** Teams this member is on (team ids). */
  teamIds: string[];
}

export interface TeamVM {
  teamId: string;
  name: string;
  slug: string;
  memberIds: string[];
  sourceIds: string[];
}

export interface SourceVM {
  id: string;
  kind: string;
  label: string;
}

export interface PendingInviteVM {
  token: string;
  role: string;
  canInviteBot: boolean;
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
  name: string | null;
  teamId: string | null;
}

type WorkspaceRole = 'member' | 'manager' | 'super_admin';

/**
 * Unified Teams & members surface. A left rail switches the main panel between
 * the All-members roster and a per-team detail view; an Invite modal mints links.
 * Backend logic is entirely reused — every mutation routes through the existing
 * server actions (changeRole/removeMember/createInvite/revokeInvite, createTeam,
 * add/removeTeamMember, add/removeTeamSource) and reconciles via their
 * revalidatePath('/teams').
 */
export function TeamsMembersClient({
  orgName,
  members,
  teams,
  sources,
  invites,
  isSuperAdmin,
}: {
  orgName: string;
  members: MemberVM[];
  teams: TeamVM[];
  sources: SourceVM[];
  invites: PendingInviteVM[];
  isSuperAdmin: boolean;
}): ReactElement {
  // null = All members; otherwise a team id.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  // `now` is null through SSR + first paint so relative-time labels can't cause a
  // hydration mismatch; set after mount (same discipline as the old member list).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const teamById = useMemo(() => new Map(teams.map((t) => [t.teamId, t])), [teams]);
  const selectedTeam = selectedTeamId !== null ? (teamById.get(selectedTeamId) ?? null) : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-8">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Teams &amp; members</h1>
          <p className="mt-2 max-w-2xl text-pretty text-muted">
            Manage who can access <span className="font-semibold text-fg">{orgName}</span>, group them
            into teams, and choose what each team searches.
          </p>
        </div>
        <button type="button" onClick={() => setInviteOpen(true)} className={primaryButtonClass}>
          <PlusGlyph />
          Invite people
        </button>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        <LeftRail
          members={members}
          teams={teams}
          selectedTeamId={selectedTeamId}
          onSelectAll={() => setSelectedTeamId(null)}
          onSelectTeam={(id) => setSelectedTeamId(id)}
        />

        <main className="min-w-0">
          {selectedTeam !== null ? (
            <TeamDetail
              key={selectedTeam.teamId}
              team={selectedTeam}
              members={members}
              sources={sources}
              onBack={() => setSelectedTeamId(null)}
            />
          ) : (
            <AllMembersView
              members={members}
              teams={teams}
              invites={invites}
              now={now}
              isSuperAdmin={isSuperAdmin}
            />
          )}
        </main>
      </div>

      {inviteOpen ? (
        <InviteModal teams={teams} onClose={() => setInviteOpen(false)} />
      ) : null}
    </div>
  );
}

// ── Left rail ─────────────────────────────────────────────────────────────────

function LeftRail({
  members,
  teams,
  selectedTeamId,
  onSelectAll,
  onSelectTeam,
}: {
  members: MemberVM[];
  teams: TeamVM[];
  selectedTeamId: string | null;
  onSelectAll: () => void;
  onSelectTeam: (id: string) => void;
}): ReactElement {
  const [creating, setCreating] = useState(false);
  return (
    <aside className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onSelectAll}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
          selectedTeamId === null
            ? 'border-accent/40 bg-accent-soft'
            : 'border-border bg-card/40 hover:border-accent/30'
        }`}
      >
        <span className="flex items-center gap-2.5">
          <PeopleGlyph />
          <span className="text-sm font-medium text-fg">All members</span>
        </span>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-muted">
          {members.length}
        </span>
      </button>

      <div>
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Teams · {teams.length}
          </h2>
          <button
            type="button"
            aria-label="Create team"
            onClick={() => setCreating((c) => !c)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-card hover:text-fg"
          >
            <PlusGlyph />
          </button>
        </div>

        {creating ? <CreateTeamInline onDone={() => setCreating(false)} /> : null}

        <ul className="flex flex-col gap-1.5">
          {teams.map((t) => (
            <li key={t.teamId}>
              <button
                type="button"
                onClick={() => onSelectTeam(t.teamId)}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                  t.teamId === selectedTeamId
                    ? 'border-accent/50 bg-accent-soft'
                    : 'border-border bg-card/40 hover:border-accent/30'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className={`h-2.5 w-2.5 flex-none rounded-full ${teamDotColor(t.teamId)}`} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-fg">{t.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">#{t.slug}</span>
                  </span>
                </span>
                <span className="flex flex-none flex-col items-end text-[11px] text-muted">
                  <span>{t.memberIds.length} {t.memberIds.length === 1 ? 'member' : 'members'}</span>
                  <span>{t.sourceIds.length} {t.sourceIds.length === 1 ? 'source' : 'sources'}</span>
                </span>
              </button>
            </li>
          ))}
          {teams.length === 0 && !creating ? (
            <li className="rounded-xl border border-border bg-card/30 px-3.5 py-4 text-center text-xs text-muted">
              No teams yet.
            </li>
          ) : null}
        </ul>
      </div>
    </aside>
  );
}

function CreateTeamInline({ onDone }: { onDone: () => void }): ReactElement {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(): void {
    setError(null);
    start(async () => {
      const result = await createTeamAction(name.trim(), slugify(name));
      if (result.ok) {
        setName('');
        onDone();
      } else {
        setError(createTeamErrorMessage(result.error));
      }
    });
  }

  return (
    <div className="mb-2 rounded-xl border border-border bg-card/40 p-2.5">
      <input
        type="text"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim().length > 0) submit();
          if (e.key === 'Escape') onDone();
        }}
        placeholder="Team name"
        maxLength={60}
        className="w-full rounded-lg border border-border bg-bg/60 px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || name.trim().length === 0}
          className={`${primaryButtonClass} flex-1 px-2.5 py-1.5 text-xs`}
        >
          {pending ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:text-fg"
        >
          Cancel
        </button>
      </div>
      {error !== null ? <p role="alert" className="mt-1.5 text-xs text-error">{error}</p> : null}
    </div>
  );
}

// ── All-members view ───────────────────────────────────────────────────────────

function AllMembersView({
  members,
  teams,
  invites,
  now,
  isSuperAdmin,
}: {
  members: MemberVM[];
  teams: TeamVM[];
  invites: PendingInviteVM[];
  now: number | null;
  isSuperAdmin: boolean;
}): ReactElement {
  const [query, setQuery] = useState('');
  const teamById = useMemo(() => new Map(teams.map((t) => [t.teamId, t])), [teams]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return members;
    return members.filter((m) => `${m.name ?? ''} ${m.email}`.toLowerCase().includes(q));
  }, [members, query]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-64 max-w-full">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            className="w-full rounded-lg border border-border bg-card/60 py-1.5 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
          />
        </div>
        <p className="text-xs text-muted">
          Members can see every team; admins manage roles &amp; assignment.
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="grid grid-cols-[1fr_auto_auto_auto_36px] items-center gap-4 border-b border-border bg-card/40 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted sm:gap-6">
          <span>Member</span>
          <span className="hidden md:block">Teams</span>
          <span className="hidden sm:block">Last active</span>
          <span>Role</span>
          <span />
        </div>
        <ul>
          {filtered.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              teamById={teamById}
              now={now}
              isSuperAdmin={isSuperAdmin}
            />
          ))}
          {filtered.length === 0 ? (
            <li className="px-5 py-8 text-center text-sm text-muted">No members match “{query}”.</li>
          ) : null}
        </ul>
      </div>

      {invites.length > 0 ? (
        <section className="mt-9">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Pending invites · {invites.length}
          </h2>
          <ul className="flex flex-col gap-3">
            {invites.map((inv) => (
              <PendingInviteRow key={inv.token} invite={inv} teamById={teamById} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function MemberRow({
  member,
  teamById,
  now,
  isSuperAdmin,
}: {
  member: MemberVM;
  teamById: Map<string, TeamVM>;
  now: number | null;
  isSuperAdmin: boolean;
}): ReactElement | null {
  const [role, setRole] = useState(member.role);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onRoleChange(next: WorkspaceRole): void {
    const prev = role;
    setRole(next);
    setError(null);
    start(async () => {
      const result = await changeRoleAction(member.userId, next);
      if (!result.ok) {
        setRole(prev);
        setError(roleErrorMessage(result.error));
      }
    });
  }

  function onRemove(): void {
    setError(null);
    start(async () => {
      const result = await removeMemberAction(member.userId);
      if (result.ok) setRemoved(true);
      else setError(roleErrorMessage(result.error));
    });
  }

  if (removed) return null;

  const active = lastActive(member, now);
  const memberTeams = member.teamIds
    .map((id) => teamById.get(id))
    .filter((t): t is TeamVM => t !== undefined);

  return (
    <li className="grid grid-cols-[1fr_auto_auto_auto_36px] items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0 sm:gap-6">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={member.name ?? member.email} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-fg">{member.name ?? member.email}</span>
            {member.isSelf ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                You
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted">{member.email}</p>
        </div>
      </div>

      <div className="hidden min-w-0 max-w-[220px] flex-wrap gap-1.5 md:flex">
        {memberTeams.length === 0 ? (
          <span className="text-xs text-muted">—</span>
        ) : (
          memberTeams.map((t) => (
            <span
              key={t.teamId}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-fg"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${teamDotColor(t.teamId)}`} />
              {t.name}
            </span>
          ))
        )}
      </div>

      <span className={`hidden whitespace-nowrap text-sm sm:flex sm:items-center sm:gap-1.5 ${active.live ? 'text-emerald-400' : 'text-muted'}`}>
        {active.live ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> : null}
        {active.text}
      </span>

      {member.isSelf ? (
        <RoleBadge role={role} />
      ) : (
        <RoleSelect
          value={role as WorkspaceRole}
          onChange={onRoleChange}
          disabled={pending}
          isSuperAdmin={isSuperAdmin}
        />
      )}

      {member.isSelf ? (
        <span />
      ) : (
        <ActionMenu onRemove={onRemove} email={member.email} />
      )}

      {error !== null ? (
        <p role="alert" className="col-span-full text-xs text-error">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function PendingInviteRow({
  invite,
  teamById,
  now,
}: {
  invite: PendingInviteVM;
  teamById: Map<string, TeamVM>;
  now: number | null;
}): ReactElement | null {
  const [revoked, setRevoked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function revoke(): void {
    setError(null);
    start(async () => {
      const result = await revokeInviteAction(invite.token);
      if (result.ok) setRevoked(true);
      else setError(result.error);
    });
  }

  function copy(): void {
    const url = typeof window !== 'undefined' ? `${window.location.origin}/invite/${invite.token}` : '';
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (revoked) return null;

  const created = now !== null ? relativeTime(invite.createdAt, now) : shortDate(invite.createdAt);
  const expires = shortDate(invite.expiresAt);
  const team = invite.teamId !== null ? (teamById.get(invite.teamId) ?? null) : null;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card/30 px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted">
        <EnvelopeGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
          {invite.name !== null && invite.name.length > 0 ? invite.name : 'Invite link'}
          {team !== null ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-fg">
              <span className={`h-1.5 w-1.5 rounded-full ${teamDotColor(team.teamId)}`} />
              {team.name}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted">
          {invite.invitedByName !== null ? `Invited by ${invite.invitedByName} · ` : ''}
          {created} · expires {expires}
        </p>
      </div>
      <RoleBadge role={invite.role} />
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent/40"
      >
        <LinkGlyph />
        {copied ? 'Copied' : 'Copy link'}
      </button>
      <button
        type="button"
        onClick={revoke}
        disabled={pending}
        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-400 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
      >
        Revoke
      </button>
      {error !== null ? (
        <p role="alert" className="w-full text-xs text-error">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ── Invite modal ───────────────────────────────────────────────────────────────

function InviteModal({
  teams,
  onClose,
}: {
  teams: TeamVM[];
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'manager' | 'member'>('member');
  const [teamId, setTeamId] = useState<string>('');
  const [canInviteBot, setCanInviteBot] = useState(true);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  // Re-mint whenever the link's parameters change; an already-generated link is
  // bound to its role/team, so stale params must invalidate it.
  function invalidate(): void {
    setLink(null);
    setCopied(false);
  }

  function generate(): void {
    setError(null);
    setCopied(false);
    const fd = new FormData();
    fd.set('name', name.trim());
    fd.set('role', role);
    fd.set('can_invite_bot', role === 'member' && canInviteBot ? 'true' : 'false');
    fd.set('team_id', teamId);
    start(async () => {
      const result = await createInviteAction(fd);
      if (result.ok) {
        setLink(result.url);
        void navigator.clipboard.writeText(result.url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Invite teammates"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Invite teammates</h2>
            <p className="mt-1 text-sm text-muted">
              Generate a shareable invite link, then send it to your teammate.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-fg"
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-fg">Who&rsquo;s this for?</span>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                invalidate();
              }}
              placeholder="e.g. Priya"
              className="w-full rounded-xl border border-border bg-bg/60 px-3.5 py-2.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-fg">Role</span>
              <div className="relative">
                <span className={`pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${ROLE_DOT[role]}`} />
                <select
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value === 'manager' ? 'manager' : 'member');
                    invalidate();
                  }}
                  className="w-full cursor-pointer appearance-none rounded-xl border border-border bg-bg/60 py-2.5 pl-7 pr-8 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none"
                >
                  <option value="member">Member</option>
                  <option value="manager">Admin</option>
                </select>
                <ChevronDown />
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-fg">Add to team</span>
              <div className="relative">
                {teamId !== '' ? (
                  <span className={`pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${teamDotColor(teamId)}`} />
                ) : null}
                <select
                  value={teamId}
                  onChange={(e) => {
                    setTeamId(e.target.value);
                    invalidate();
                  }}
                  className={`w-full cursor-pointer appearance-none rounded-xl border border-border bg-bg/60 py-2.5 ${teamId !== '' ? 'pl-7' : 'pl-3.5'} pr-8 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none`}
                >
                  <option value="">No team</option>
                  {teams.map((t) => (
                    <option key={t.teamId} value={t.teamId}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <ChevronDown />
              </div>
            </label>
          </div>

          <div
            className={`flex items-center justify-between gap-3 rounded-xl border border-border bg-bg/40 px-4 py-3 ${role === 'manager' ? 'opacity-50' : ''}`}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Can invite the bot to their meetings</p>
              <p className="text-xs text-muted">Lets them add Risezome to calls they own.</p>
            </div>
            <Toggle
              checked={role === 'manager' ? true : canInviteBot}
              disabled={role === 'manager'}
              onChange={(v) => {
                setCanInviteBot(v);
                invalidate();
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              readOnly
              value={link ?? ''}
              placeholder="risezome.app/invite/…"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-[180px] flex-1 rounded-xl border border-border bg-bg/60 px-3.5 py-2.5 text-xs text-muted focus:outline-none"
            />
            <button
              type="button"
              onClick={generate}
              disabled={pending}
              className={primaryButtonClass}
            >
              <LinkGlyph />
              {pending ? 'Generating…' : copied ? 'Copied' : 'Generate & copy'}
            </button>
          </div>

          {error !== null ? (
            <p role="alert" className="text-sm text-error">{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────────

const ROLE_DOT: Record<string, string> = {
  super_admin: 'bg-amber-400',
  manager: 'bg-violet-400',
  member: 'bg-emerald-400',
};

function roleErrorMessage(error: string): string {
  if (error === 'last_super_admin') return 'Workspace needs at least one Super Admin.';
  if (error === 'last_manager') return 'Workspace needs at least one Admin.';
  if (error === 'forbidden') return 'Only a Super Admin can change that role.';
  return error;
}

function createTeamErrorMessage(error: string): string {
  switch (error) {
    case 'empty_name':
      return 'Team name is required.';
    case 'name_too_long':
      return 'Name too long (max 60).';
    case 'duplicate_slug':
      return 'A team with that name already exists.';
    default:
      return 'Could not create the team.';
  }
}

function RoleBadge({ role }: { role: string }): ReactElement {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg">
      <span className={`h-2 w-2 rounded-full ${ROLE_DOT[role] ?? 'bg-slate-400'}`} />
      {roleLabel(role)}
    </span>
  );
}

/**
 * Member-row role control. Member/Admin always available; the Super Admin option
 * is only offered to a super_admin caller — mirroring changeRoleAction's gate
 * (granting OR removing super_admin requires the caller to BE one). A
 * non-super_admin never sees the option, so can't attempt the forbidden path.
 */
function RoleSelect({
  value,
  onChange,
  disabled = false,
  isSuperAdmin,
}: {
  value: WorkspaceRole;
  onChange: (v: WorkspaceRole) => void;
  disabled?: boolean;
  isSuperAdmin: boolean;
}): ReactElement {
  // If the target is already a super_admin, show the option even to a non-super
  // caller (so the select reflects reality) but the server still gates the write.
  const showSuper = isSuperAdmin || value === 'super_admin';
  return (
    <div className="relative">
      <span className={`pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${ROLE_DOT[value]}`} />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(toWorkspaceRole(e.target.value))}
        className="cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pl-7 pr-8 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none disabled:opacity-60"
      >
        <option value="member">Member</option>
        <option value="manager">Admin</option>
        {showSuper ? <option value="super_admin">Super Admin</option> : null}
      </select>
      <ChevronDown />
    </div>
  );
}

function toWorkspaceRole(v: string): WorkspaceRole {
  if (v === 'manager' || v === 'super_admin') return v;
  return 'member';
}

function ActionMenu({ onRemove, email }: { onRemove: () => void; email: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex justify-end">
      <button
        type="button"
        aria-label="Member actions"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card hover:text-fg"
      >
        <DotsGlyph />
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
          <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(email);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-accent-soft/50"
            >
              Copy email
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-rose-400 hover:bg-rose-500/10"
            >
              Remove from workspace
            </button>
          </div>
        </>
      ) : null}
    </div>
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

export function Toggle({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-border'
      } ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ── time helpers (reused from members/_member-list.tsx) ────────────────────────

function lastActive(member: MemberVM, now: number | null): { text: string; live: boolean } {
  if (member.isSelf) return { text: 'Active now', live: true };
  if (member.lastSignInAt === null) return { text: 'Never signed in', live: false };
  if (now === null) return { text: shortDate(member.lastSignInAt), live: false };
  // "Active now" when the last sign-in is within ~5 minutes.
  if (now - new Date(member.lastSignInAt).getTime() < 5 * 60_000) {
    return { text: 'Active now', live: true };
  }
  return { text: relativeTime(member.lastSignInAt, now), live: false };
}

function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${String(hr)}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'Yesterday';
  if (day < 7) return `${String(day)}d ago`;
  return shortDate(iso);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── glyphs ─────────────────────────────────────────────────────────────────────

function PlusGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PeopleGlyph(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden="true">
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.5a3 3 0 0 1 0 5.8M17 19a5.5 5.5 0 0 0-2.5-4.6" />
    </svg>
  );
}
function SearchIcon(): ReactElement {
  return (
    <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function ChevronDown(): ReactElement {
  return (
    <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function LinkGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" />
      <path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" />
    </svg>
  );
}
function DotsGlyph(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
function EnvelopeGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}
function CloseGlyph(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
