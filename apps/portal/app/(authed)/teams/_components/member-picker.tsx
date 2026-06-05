'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { addTeamMemberAction, removeTeamMemberAction } from '../team-actions';
import type { OrgMember } from './teams-client';

/**
 * Per-team member editor. Lists the org roster with a toggle per member: on =
 * the member is on this team. Each toggle calls add/removeTeamMemberAction and
 * optimistically updates local state, reverting on failure — the same idiom as
 * _member-list.tsx's role/bot toggles.
 */
export function MemberPicker({
  teamId,
  members,
  initialMemberIds,
  roleLabelFn,
}: {
  teamId: string;
  members: OrgMember[];
  initialMemberIds: string[];
  roleLabelFn: (role: string) => string;
}): ReactElement {
  const [memberIds, setMemberIds] = useState<Set<string>>(() => new Set(initialMemberIds));
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return members;
    return members.filter((m) => `${m.name ?? ''} ${m.email}`.toLowerCase().includes(q));
  }, [members, query]);

  function setMembership(userId: string, on: boolean): void {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-card/40 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">
          Members · {memberIds.size}
        </h3>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="w-44 rounded-lg border border-border bg-bg/60 px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
      </div>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {filtered.map((m) => (
          <MemberRow
            key={m.userId}
            teamId={teamId}
            member={m}
            on={memberIds.has(m.userId)}
            onToggle={setMembership}
            roleLabel={roleLabelFn(m.role)}
          />
        ))}
        {filtered.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-muted">No members match “{query}”.</li>
        ) : null}
      </ul>
    </section>
  );
}

function MemberRow({
  teamId,
  member,
  on,
  onToggle,
  roleLabel,
}: {
  teamId: string;
  member: OrgMember;
  on: boolean;
  onToggle: (userId: string, on: boolean) => void;
  roleLabel: string;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(): void {
    const next = !on;
    onToggle(member.userId, next); // optimistic
    setError(null);
    start(async () => {
      const result = next
        ? await addTeamMemberAction(teamId, member.userId)
        : await removeTeamMemberAction(teamId, member.userId);
      if (!result.ok) {
        onToggle(member.userId, !next); // revert
        setError(memberErrorMessage(result.error));
      }
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
        <p className="truncate text-xs text-muted">
          {member.email} · {roleLabel}
        </p>
        {error !== null ? <p role="alert" className="text-xs text-error">{error}</p> : null}
      </div>
      <Toggle checked={on} disabled={pending} onChange={toggle} label={`${member.email} on team`} />
    </li>
  );
}

function memberErrorMessage(error: string): string {
  switch (error) {
    case 'not_an_org_member':
      return 'That user is not a member of this workspace.';
    case 'team_not_found':
      return 'Team not found.';
    default:
      return 'Could not update membership. Try again.';
  }
}

function Toggle({
  checked,
  disabled = false,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
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

function Avatar({ name }: { name: string }): ReactElement {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  const initial = name.trim().length > 0 ? name.trim()[0]!.toUpperCase() : '?';
  return (
    <span
      className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-sm font-semibold text-white ${color}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
