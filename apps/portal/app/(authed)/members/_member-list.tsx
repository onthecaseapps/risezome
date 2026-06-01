'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { createInviteAction, revokeInviteAction } from './invite-action';
import { changeRoleAction, removeMemberAction, setCanInviteBotAction } from './member-actions';

export interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  canInviteBot: boolean;
  isSelf: boolean;
}

export interface PendingInvite {
  token: string;
  role: string;
  canInviteBot: boolean;
  expiresAt: string;
}

export function MemberList({
  members,
  invites,
}: {
  members: MemberRow[];
  invites: PendingInvite[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <InviteSection />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-fg">Team ({members.length})</h2>
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {members.map((m) => (
            <MemberItem key={m.userId} member={m} />
          ))}
        </ul>
      </section>

      {invites.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-fg">Pending invites ({invites.length})</h2>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {invites.map((inv) => (
              <InviteItem key={inv.token} invite={inv} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function InviteSection(): ReactElement {
  const [role, setRole] = useState<'manager' | 'member'>('member');
  const [canInviteBot, setCanInviteBot] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  function generate(): void {
    setError(null);
    setLink(null);
    setCopied(false);
    const fd = new FormData();
    fd.set('role', role);
    fd.set('can_invite_bot', role === 'member' && canInviteBot ? 'true' : 'false');
    start(async () => {
      const result = await createInviteAction(fd);
      if (result.ok) setLink(result.url);
      else setError(result.error);
    });
  }

  function copy(): void {
    if (link === null) return;
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-fg">Invite a teammate</h2>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value === 'manager' ? 'manager' : 'member')}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="member">Member</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        {role === 'member' && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={canInviteBot}
              onChange={(e) => setCanInviteBot(e.target.checked)}
            />
            Can invite the bot
          </label>
        )}
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-press disabled:opacity-60"
        >
          {pending ? 'Generating…' : 'Generate link'}
        </button>
      </div>

      {link !== null && (
        <div className="mt-3 flex items-center gap-2">
          <input
            readOnly
            value={link}
            className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-muted"
          />
          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
    </section>
  );
}

function MemberItem({ member }: { member: MemberRow }): ReactElement {
  const [role, setRole] = useState(member.role);
  const [canInviteBot, setCanInviteBot] = useState(member.canInviteBot);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onRoleChange(next: string): void {
    const prev = role;
    setRole(next);
    setError(null);
    start(async () => {
      const result = await changeRoleAction(member.userId, next);
      if (!result.ok) {
        setRole(prev);
        setError(result.error === 'last_manager' ? 'Workspace needs at least one manager.' : result.error);
      }
    });
  }

  function onGrantChange(next: boolean): void {
    setCanInviteBot(next);
    setError(null);
    start(async () => {
      const result = await setCanInviteBotAction(member.userId, next);
      if (!result.ok) {
        setCanInviteBot(!next);
        setError(result.error);
      }
    });
  }

  function onRemove(): void {
    setError(null);
    start(async () => {
      const result = await removeMemberAction(member.userId);
      if (!result.ok) {
        setError(result.error === 'last_manager' ? 'Workspace needs at least one manager.' : result.error);
      }
    });
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {member.name ?? member.email}
          {member.isSelf && <span className="ml-2 text-xs text-muted">(you)</span>}
        </p>
        {member.name !== null && <p className="truncate text-xs text-muted">{member.email}</p>}
      </div>

      <select
        value={role}
        onChange={(e) => onRoleChange(e.target.value)}
        disabled={pending}
        className="rounded-md border border-border bg-card px-2 py-1 text-sm"
      >
        <option value="member">Member</option>
        <option value="manager">Manager</option>
      </select>

      <label
        className={`flex items-center gap-1.5 text-xs ${role === 'manager' ? 'opacity-40' : 'text-muted'}`}
        title="Managers can always invite the bot"
      >
        <input
          type="checkbox"
          checked={role === 'manager' ? true : canInviteBot}
          disabled={pending || role === 'manager'}
          onChange={(e) => onGrantChange(e.target.checked)}
        />
        Bot invite
      </label>

      <button
        type="button"
        onClick={onRemove}
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-error hover:text-error disabled:opacity-50"
      >
        Remove
      </button>

      {error !== null && (
        <p role="alert" className="w-full text-xs text-error">
          {error}
        </p>
      )}
    </li>
  );
}

function InviteItem({ invite }: { invite: PendingInvite }): ReactElement {
  const [revoked, setRevoked] = useState(false);
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

  if (revoked) return <></>;

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">
          {invite.role === 'manager' ? 'Manager' : 'Member'} invite
          {invite.role === 'member' && invite.canInviteBot && (
            <span className="ml-2 text-xs text-muted">· can invite the bot</span>
          )}
        </p>
        <p className="text-xs text-muted">Expires {new Date(invite.expiresAt).toLocaleDateString()}</p>
      </div>
      <button
        type="button"
        onClick={revoke}
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-error hover:text-error disabled:opacity-50"
      >
        Revoke
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </li>
  );
}
