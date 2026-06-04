'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactElement,
} from 'react';
import { createInviteAction, revokeInviteAction } from './invite-action';
import { changeRoleAction, removeMemberAction, setCanInviteBotAction } from './member-actions';
import { primaryButtonClass } from '../_components/ui';

export interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  canInviteBot: boolean;
  isSelf: boolean;
  lastSignInAt: string | null;
}

export interface PendingInvite {
  token: string;
  role: string;
  canInviteBot: boolean;
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
  /** Who the link is for (recipient label). Null for unlabeled links. */
  name: string | null;
}

export function MembersClient({
  members,
  invites,
  orgName,
}: {
  members: MemberRow[];
  invites: PendingInvite[];
  orgName: string;
}): ReactElement {
  const [query, setQuery] = useState('');
  const inviteRef = useRef<HTMLDivElement>(null);

  // `now` stays null through SSR + first hydration paint so relative-time
  // labels (which depend on the clock) can't cause a hydration mismatch; it's
  // set after mount, at which point rows refine to "2h ago" etc.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return members;
    return members.filter((m) => `${m.name ?? ''} ${m.email}`.toLowerCase().includes(q));
  }, [members, query]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Members</h1>
          <p className="mt-2 text-pretty text-muted">
            Manage who can access <span className="font-medium text-fg">{orgName}</span> and what they
            can do.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-muted">
            {members.length} {members.length === 1 ? 'member' : 'members'}
          </span>
          <button
            type="button"
            onClick={() => {
              inviteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
            className={primaryButtonClass}
          >
            <PlusGlyph />
            Invite
          </button>
        </div>
      </header>

      <div ref={inviteRef}>
        <InviteCard />
      </div>

      <section className="mt-9">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Team · {members.length}
          </h2>
          <div className="relative w-56 max-w-[55%]">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              className="w-full rounded-lg border border-border bg-card/60 py-1.5 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border">
          <div className="grid grid-cols-[1fr_auto_auto_auto_36px] items-center gap-4 border-b border-border bg-card/40 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted sm:gap-6">
            <span>Member</span>
            <span className="hidden sm:block">Last active</span>
            <span className="hidden sm:block">Bot access</span>
            <span>Role</span>
            <span />
          </div>
          <ul>
            {filtered.map((m) => (
              <MemberRowView key={m.userId} member={m} now={now} />
            ))}
            {filtered.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-muted">No members match “{query}”.</li>
            ) : null}
          </ul>
        </div>
      </section>

      {invites.length > 0 ? (
        <section className="mt-9">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Pending invites · {invites.length}
          </h2>
          <ul className="flex flex-col gap-3">
            {invites.map((inv) => (
              <PendingInviteRow key={inv.token} invite={inv} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── Invite card (link-based) ────────────────────────────────────────────────

function InviteCard(): ReactElement {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'manager' | 'member'>('member');
  const [canInviteBot, setCanInviteBot] = useState(true);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  function generate(): void {
    setError(null);
    setCopied(false);
    const fd = new FormData();
    fd.set('name', name.trim());
    fd.set('role', role);
    fd.set('can_invite_bot', role === 'member' && canInviteBot ? 'true' : 'false');
    start(async () => {
      const result = await createInviteAction(fd);
      if (result.ok) setLink(result.url);
      else setError(result.error);
    });
  }

  function copy(): void {
    if (link === null) {
      generate();
      return;
    }
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-card/40 p-5">
      <h2 className="text-sm font-semibold text-fg">Invite teammates</h2>
      <p className="mt-1 text-sm text-muted">
        Generate a shareable invite link for the role below, then send it to your teammate.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setLink(null);
          }}
          placeholder="Who's this for? (e.g. Priya)"
          className="min-w-[180px] flex-1 rounded-xl border border-border bg-bg/60 px-3.5 py-2.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
        <RoleSelect
          value={role}
          onChange={(r) => {
            setRole(r);
            setLink(null);
          }}
        />
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'Generating…' : link === null ? 'Generate link' : 'New link'}
        </button>
      </div>

      {link !== null ? (
        <div className="mt-3">
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-xl border border-border bg-bg/60 px-3.5 py-2 text-xs text-muted focus:outline-none"
          />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
        <label
          className={`flex items-center gap-2.5 text-sm ${role === 'manager' ? 'opacity-50' : ''}`}
          title={role === 'manager' ? 'Managers can always invite the bot' : undefined}
        >
          <Toggle
            checked={role === 'manager' ? true : canInviteBot}
            disabled={role === 'manager'}
            onChange={(v) => { setCanInviteBot(v); setLink(null); }}
          />
          <span className="font-medium text-fg">Can invite the bot to their meetings</span>
          <span className="hidden text-muted sm:inline">— lets them add Risezome to calls they own.</span>
        </label>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 disabled:opacity-60"
          disabled={pending}
        >
          <LinkGlyph />
          {copied ? 'Copied' : link === null ? 'Generate & copy' : 'Copy invite link'}
        </button>
      </div>

      {error !== null ? (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ── Member row ──────────────────────────────────────────────────────────────

function MemberRowView({ member, now }: { member: MemberRow; now: number | null }): ReactElement | null {
  const [role, setRole] = useState(member.role);
  const [canInviteBot, setCanInviteBot] = useState(member.canInviteBot);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onRoleChange(next: 'manager' | 'member'): void {
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

  function onBotChange(next: boolean): void {
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
      if (result.ok) setRemoved(true);
      else setError(result.error === 'last_manager' ? 'Workspace needs at least one manager.' : result.error);
    });
  }

  if (removed) return null;

  const isManager = role === 'manager';
  const active = lastActive(member, now);

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

      <span className={`hidden whitespace-nowrap text-sm sm:flex sm:items-center sm:gap-1.5 ${active.live ? 'text-emerald-400' : 'text-muted'}`}>
        {active.live ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> : null}
        {active.text}
      </span>

      <span className="hidden items-center gap-2 sm:flex">
        <Toggle
          checked={isManager ? true : canInviteBot}
          disabled={pending || isManager || member.isSelf}
          onChange={onBotChange}
        />
        <span className="text-xs text-muted">Bot</span>
      </span>

      {member.isSelf ? (
        <RoleBadge role={role} />
      ) : (
        <RoleSelect value={role as 'manager' | 'member'} onChange={onRoleChange} disabled={pending} />
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

// ── Pending invite row ──────────────────────────────────────────────────────

function PendingInviteRow({ invite, now }: { invite: PendingInvite; now: number | null }): ReactElement | null {
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

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card/30 px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted">
        <EnvelopeGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {invite.name !== null && invite.name.length > 0 ? invite.name : 'Invite link'}
        </p>
        <p className="truncate text-xs text-muted">
          {invite.invitedByName !== null ? `Invited by ${invite.invitedByName} · ` : ''}
          {created} · expires {expires}
          {invite.role === 'member' && invite.canInviteBot ? ' · can invite the bot' : ''}
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

// ── Bits ────────────────────────────────────────────────────────────────────

const ROLE_DOT: Record<string, string> = {
  manager: 'bg-violet-400',
  member: 'bg-sky-400',
  viewer: 'bg-slate-400',
};

function RoleBadge({ role }: { role: string }): ReactElement {
  const label = role === 'manager' ? 'Manager' : role === 'viewer' ? 'Viewer' : 'Member';
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg">
      <span className={`h-2 w-2 rounded-full ${ROLE_DOT[role] ?? 'bg-slate-400'}`} />
      {label}
    </span>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: 'manager' | 'member';
  onChange: (v: 'manager' | 'member') => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="relative">
      <span className={`pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${ROLE_DOT[value]}`} />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === 'manager' ? 'manager' : 'member')}
        className="cursor-pointer appearance-none rounded-lg border border-border bg-card py-1.5 pl-7 pr-8 text-sm font-medium text-fg focus:border-accent/50 focus:outline-none disabled:opacity-60"
      >
        <option value="member">Member</option>
        <option value="manager">Manager</option>
      </select>
      <ChevronDown />
    </div>
  );
}

function Toggle({
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

// ── time helpers ────────────────────────────────────────────────────────────

function lastActive(member: MemberRow, now: number | null): { text: string; live: boolean } {
  if (member.isSelf) return { text: 'Active now', live: true };
  if (member.lastSignInAt === null) return { text: 'Never signed in', live: false };
  if (now === null) return { text: shortDate(member.lastSignInAt), live: false };
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
  if (day < 7) return `${String(day)} days ago`;
  return shortDate(iso);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── glyphs ──────────────────────────────────────────────────────────────────

function PlusGlyph(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
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
