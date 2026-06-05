'use client';

import { useMemo, useState, useTransition, type ReactElement } from 'react';
import { createTeamAction } from '../team-actions';
import { slugify } from '../_lib/team-validation';
import { roleLabel } from '../../../_lib/roles';
import { primaryButtonClass } from '../../_components/ui';
import { MemberPicker } from './member-picker';
import { SourcePicker } from './source-picker';

export interface OrgMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  isSelf: boolean;
}

export interface TeamSourceRow {
  id: string;
  kind: string;
  label: string;
}

export interface TeamRow {
  teamId: string;
  name: string;
  slug: string;
  memberIds: string[];
  sourceIds: string[];
}

/**
 * Teams management surface. Left: the team list (with create). Right: the editor
 * for the selected team — a member picker + a source picker, each mirroring
 * _member-list.tsx's client-action idiom (useTransition + action result +
 * optimistic local state, reconciled by the action's revalidatePath('/teams')).
 */
export function TeamsClient({
  orgName,
  teams,
  members,
  sources,
}: {
  orgName: string;
  teams: TeamRow[];
  members: OrgMember[];
  sources: TeamSourceRow[];
}): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(teams[0]?.teamId ?? null);
  const selected = useMemo(
    () => teams.find((t) => t.teamId === selectedId) ?? null,
    [teams, selectedId],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8">
      <header className="mb-7">
        <h1 className="text-4xl font-bold tracking-tight">Teams</h1>
        <p className="mt-2 text-pretty text-muted">
          Group members of <span className="font-medium text-fg">{orgName}</span> and choose which
          sources each team searches.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        <aside>
          <CreateTeamCard />
          <ul className="mt-4 flex flex-col gap-1.5">
            {teams.map((t) => (
              <li key={t.teamId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(t.teamId)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl border px-4 py-3 text-left transition-colors ${
                    t.teamId === selectedId
                      ? 'border-accent/50 bg-accent-soft'
                      : 'border-border bg-card/40 hover:border-accent/30'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">{t.name}</span>
                    <span className="block truncate text-xs text-muted">{t.slug}</span>
                  </span>
                  <span className="flex flex-none flex-col items-end text-[11px] text-muted">
                    <span>{t.memberIds.length} {t.memberIds.length === 1 ? 'member' : 'members'}</span>
                    <span>{t.sourceIds.length} {t.sourceIds.length === 1 ? 'source' : 'sources'}</span>
                  </span>
                </button>
              </li>
            ))}
            {teams.length === 0 ? (
              <li className="rounded-xl border border-border bg-card/30 px-4 py-6 text-center text-sm text-muted">
                No teams yet. Create your first one above.
              </li>
            ) : null}
          </ul>
        </aside>

        <section className="min-w-0">
          {selected !== null ? (
            <TeamEditor
              key={selected.teamId}
              team={selected}
              members={members}
              sources={sources}
            />
          ) : (
            <div className="rounded-2xl border border-border bg-card/30 px-6 py-16 text-center text-sm text-muted">
              Select a team to manage its members and sources.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Create team ─────────────────────────────────────────────────────────────

function CreateTeamCard(): ReactElement {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const effectiveSlug = slugTouched ? slug : slugify(name);

  function submit(): void {
    setError(null);
    start(async () => {
      const result = await createTeamAction(name.trim(), effectiveSlug);
      if (result.ok) {
        setName('');
        setSlug('');
        setSlugTouched(false);
      } else {
        setError(createErrorMessage(result.error));
      }
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-card/40 p-4">
      <h2 className="text-sm font-semibold text-fg">New team</h2>
      <div className="mt-3 flex flex-col gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Team name"
          maxLength={60}
          className="w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
        <input
          type="text"
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          placeholder="slug"
          maxLength={50}
          className="w-full rounded-lg border border-border bg-bg/60 px-3 py-2 font-mono text-xs text-muted focus:border-accent/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending || name.trim().length === 0}
          className={`${primaryButtonClass} w-full`}
        >
          {pending ? 'Creating…' : 'Create team'}
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ── Per-team editor ─────────────────────────────────────────────────────────

function TeamEditor({
  team,
  members,
  sources,
}: {
  team: TeamRow;
  members: OrgMember[];
  sources: TeamSourceRow[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-card/40 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-fg">{team.name}</h2>
          <span className="font-mono text-xs text-muted">{team.slug}</span>
        </div>
      </div>

      <MemberPicker
        teamId={team.teamId}
        members={members}
        initialMemberIds={team.memberIds}
        roleLabelFn={roleLabel}
      />

      <SourcePicker
        teamId={team.teamId}
        sources={sources}
        initialSourceIds={team.sourceIds}
      />
    </div>
  );
}

function createErrorMessage(error: string): string {
  switch (error) {
    case 'empty_name':
      return 'Team name is required.';
    case 'name_too_long':
      return 'Team name is too long (max 60 characters).';
    case 'empty_slug':
    case 'invalid_slug':
      return 'Slug must be lowercase letters, numbers, and single dashes.';
    case 'slug_too_long':
      return 'Slug is too long (max 50 characters).';
    case 'duplicate_slug':
      return 'A team with that slug already exists. Pick a different slug.';
    default:
      return 'Could not create the team. Try again.';
  }
}
