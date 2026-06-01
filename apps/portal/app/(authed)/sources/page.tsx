import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { requireTrelloApiKey } from '../../_lib/trello';
import { listBoards } from '../../_lib/trello-client';
import { getValidAtlassianToken } from '../../_lib/atlassian-token';
import { listConfluenceSpaces, listJiraProjects } from '../../_lib/atlassian-client';
import { SourcesAutoRefresh } from './_auto-refresh';
import { SourceActions } from './_source-actions';
import { ConnectionSources } from './_connection-sources';
import { TrelloMark, JiraMark, ConfluenceMark } from './_source-icons';

interface TrelloSourceRow {
  id: string;
  kind?: string;
  display_name: string | null;
  external_id: string | null;
  status: string;
  status_message: string | null;
  indexed_files: number;
  total_files: number | null;
  last_indexed_at: string | null;
}

/**
 * Sources view. Shows the org's GitHub App installation status + the list of
 * indexed repos, plus a connectors summary at the bottom.
 *
 * Layout follows the design mockup: a card-per-repo list with status icons +
 * (when relevant) progress bars and Retry buttons, then a Connectors section
 * with GitHub marked connected and Jira/Slack stubbed as coming-soon.
 *
 * Read model:
 *   - `github_installations` for the org (RLS-scoped)
 *   - `sources` for the org, filtered to status != 'removed'
 *
 * Banner: ?installed=true, ?notice=*, ?error=* surface a one-shot banner.
 */

interface SourceRow {
  id: string;
  repo_full_name: string;
  default_branch: string | null;
  status: string;
  status_message: string | null;
  indexed_files: number;
  total_files: number | null;
  chunk_count: number;
  last_indexed_at: string | null;
}

interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: string;
  suspended_at: string | null;
}

export default async function SourcesPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { orgId } = await requireAuthedUserWithOrg();
  const searchParams = await props.searchParams;

  const supabase = await createServerClient();
  const { data: installRows } = await supabase
    .from('github_installations')
    .select('installation_id, account_login, account_type, suspended_at')
    .eq('org_id', orgId)
    .is('removed_at', null);

  const installation = ((installRows ?? [])[0] ?? null) as InstallationRow | null;

  let sources: SourceRow[] = [];
  if (installation !== null) {
    const { data: srcRows } = await supabase
      .from('sources')
      .select(
        'id, repo_full_name, default_branch, status, status_message, indexed_files, total_files, chunk_count, last_indexed_at',
      )
      .eq('org_id', orgId)
      .eq('installation_id', installation.installation_id)
      .neq('status', 'removed')
      .order('repo_full_name', { ascending: true });
    sources = (srcRows ?? []) as SourceRow[];
  }

  // Trello: connection + sources + available boards. The token table is
  // service-role only, so read it (and list boards) with the service-role
  // client; trello sources are RLS-readable by org members.
  const serviceRole = createServiceRoleClient();
  const { data: trelloConnRow } = await serviceRole
    .from('trello_connections')
    .select('id, token, username')
    .eq('org_id', orgId)
    .maybeSingle();
  const trelloConnected = trelloConnRow !== null;

  let trelloSources: TrelloSourceRow[] = [];
  let trelloBoards: Array<{ id: string; name: string }> = [];
  if (trelloConnRow !== null) {
    const { data: tSrc } = await supabase
      .from('sources')
      .select('id, display_name, external_id, status, status_message, indexed_files, total_files, last_indexed_at')
      .eq('org_id', orgId)
      .eq('kind', 'trello')
      .neq('status', 'removed')
      .order('display_name', { ascending: true });
    trelloSources = (tSrc ?? []) as TrelloSourceRow[];
    const indexed = new Set(trelloSources.map((s) => s.external_id));
    try {
      const boards = await listBoards({
        token: trelloConnRow.token as string,
        apiKey: requireTrelloApiKey(),
      });
      trelloBoards = boards.filter((b) => !indexed.has(b.id)).map((b) => ({ id: b.id, name: b.name }));
    } catch {
      // Board listing failed (e.g. revoked token); leave the picker empty.
    }
  }

  // Atlassian: connection + jira/confluence sources + available projects/spaces.
  const { data: atlassianConnRow } = await serviceRole
    .from('atlassian_connections')
    .select('id')
    .eq('org_id', orgId)
    .maybeSingle();
  const atlassianConnected = atlassianConnRow !== null;

  let atlassianSources: TrelloSourceRow[] = [];
  let jiraProjects: Array<{ id: string; name: string }> = [];
  let confluenceSpaces: Array<{ id: string; name: string }> = [];
  if (atlassianConnRow !== null) {
    const { data: aSrc } = await supabase
      .from('sources')
      .select('id, kind, display_name, external_id, status, status_message, indexed_files, total_files, last_indexed_at')
      .eq('org_id', orgId)
      .in('kind', ['jira', 'confluence'])
      .neq('status', 'removed')
      .order('display_name', { ascending: true });
    atlassianSources = (aSrc ?? []) as TrelloSourceRow[];
    const indexed = new Set((aSrc ?? []).map((s) => `${s.kind as string}:${s.external_id as string}`));
    try {
      const token = await getValidAtlassianToken(orgId, serviceRole);
      const client = { accessToken: token.accessToken, cloudId: token.cloudId };
      const [projects, spaces] = await Promise.all([listJiraProjects(client), listConfluenceSpaces(client)]);
      jiraProjects = projects
        .filter((p) => !indexed.has(`jira:${p.key}`))
        .map((p) => ({ id: p.key, name: p.name }));
      confluenceSpaces = spaces
        .filter((s) => !indexed.has(`confluence:${s.id}`))
        .map((s) => ({ id: s.id, name: s.name }));
    } catch {
      // Token stale / listing failed — leave the pickers empty (re-connect prompt).
    }
  }

  const banner = readBanner(searchParams);
  const manageUrl = installation !== null
    ? buildManageUrl(installation.account_login, installation.account_type, installation.installation_id)
    : null;
  // Poll for indexer progress when any source is mid-flight.
  const hasInflight = [...sources, ...trelloSources, ...atlassianSources].some(
    (s) => s.status === 'pending' || s.status === 'indexing',
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <SourcesAutoRefresh shouldPoll={hasInflight} />
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
          <p className="mt-1.5 text-sm text-muted">
            What Risezome searches when it grounds an answer.
          </p>
        </div>
        {installation === null ? null : (
          <a
            href={manageUrl ?? '/sources/install'}
            target={manageUrl !== null ? '_blank' : undefined}
            rel={manageUrl !== null ? 'noopener noreferrer' : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-press"
          >
            <PlusIcon />
            Connect a source
          </a>
        )}
      </header>

      {banner !== null ? (
        <div
          className={
            banner.kind === 'error'
              ? 'mb-6 rounded-lg border border-rose-300/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200'
              : 'mb-6 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-fg'
          }
        >
          {banner.message}
        </div>
      ) : null}

      {installation !== null && installation.suspended_at !== null ? (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The GitHub App is suspended on <span className="font-medium">{installation.account_login}</span> —
          indexing is paused until it's reactivated.
        </div>
      ) : null}

      {installation === null && !trelloConnected && !atlassianConnected ? (
        <EmptyConnectState />
      ) : (
        <>
          {installation !== null ? (
            <>
              <SectionLabel label="Repositories" count={sources.length} />
              {sources.length === 0 ? (
                <NoReposState manageUrl={manageUrl} accountLogin={installation.account_login} />
              ) : (
                <ul className="flex flex-col gap-3">
                  {sources.map((s) => (
                    <li key={s.id}>
                      <SourceCard source={s} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}

          {trelloConnected ? (
            <div className={installation !== null ? 'mt-10' : ''}>
              <SectionLabel label="Trello boards" count={trelloSources.length} />
              <ConnectionSources
                sources={trelloSources}
                manageLabel="Manage boards"
                picker={{ kind: 'trello', boards: trelloBoards }}
              />
            </div>
          ) : null}

          {atlassianConnected ? (
            <div className="mt-10">
              <SectionLabel label="Jira & Confluence" count={atlassianSources.length} />
              <ConnectionSources
                sources={atlassianSources}
                manageLabel="Manage sources"
                picker={{ kind: 'atlassian', projects: jiraProjects, spaces: confluenceSpaces }}
              />
            </div>
          ) : null}

          <div className="mt-10">
            <SectionLabel label="Connectors" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ConnectorCard
                name="GitHub"
                icon={<GithubMark className="h-4 w-4 text-fg" />}
                status={installation !== null ? 'connected' : 'connect'}
                connectHref="/sources/install"
              />
              <ConnectorCard
                name="Trello"
                icon={<TrelloMark />}
                status={trelloConnected ? 'connected' : 'connect'}
                connectHref="/sources/trello/connect"
              />
              <ConnectorCard
                name="Jira"
                icon={<JiraMark />}
                status={atlassianConnected ? 'connected' : 'connect'}
                connectHref="/sources/atlassian/connect"
              />
              <ConnectorCard
                name="Confluence"
                icon={<ConfluenceMark />}
                status={atlassianConnected ? 'connected' : 'connect'}
                connectHref="/sources/atlassian/connect"
              />
              <ConnectorCard name="Slack" icon={<SlackMark />} status="coming-soon" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function SectionLabel({ label, count }: { label: string; count?: number }): ReactElement {
  return (
    <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
      <span>{label}</span>
      {count !== undefined ? <span>· {count}</span> : null}
    </div>
  );
}

function EmptyConnectState(): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center">
      <h2 className="text-lg font-semibold tracking-tight">Connect GitHub</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Install the Risezome GitHub App on the org or user account whose repos you want indexed.
        You choose which repos we can see.
      </p>
      <a
        href="/sources/install"
        className="mt-6 inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-press"
      >
        Connect GitHub
      </a>
    </div>
  );
}

function NoReposState({
  manageUrl,
  accountLogin,
}: {
  manageUrl: string | null;
  accountLogin: string;
}): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center">
      <h2 className="text-lg font-semibold tracking-tight">No repositories selected</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Risezome is installed on <span className="text-fg">{accountLogin}</span>, but you haven&apos;t
        granted access to any repositories yet.
      </p>
      {manageUrl !== null ? (
        <a
          href={manageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center justify-center rounded-lg border border-border bg-bg px-4 py-2 text-sm font-medium text-fg hover:bg-accent-soft"
        >
          Choose repositories on GitHub →
        </a>
      ) : null}
    </div>
  );
}

function SourceCard({ source }: { source: SourceRow }): ReactElement {
  const isErrored = source.status === 'errored';
  return (
    <div
      className={`flex items-center gap-4 rounded-xl border bg-card p-4 ${
        isErrored ? 'border-rose-400/40' : 'border-border'
      }`}
    >
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-bg">
        <GithubMark className="h-5 w-5 text-fg" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-fg">{source.repo_full_name}</span>
          {source.default_branch !== null && source.default_branch.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <BranchIcon />
              {source.default_branch}
            </span>
          ) : null}
        </div>
        <StatusLine source={source} />
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        <StatusRightSlot source={source} />
        <SourceActions
          sourceId={source.id}
          busy={source.status === 'indexing'}
          currentBranch={source.default_branch}
        />
      </div>
    </div>
  );
}

function StatusLine({ source }: { source: SourceRow }): ReactElement {
  if (source.status === 'pending') {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <ClockIcon />
        Waiting to index
      </div>
    );
  }
  if (source.status === 'indexing') {
    const pct = computePercent(source.indexed_files, source.total_files);
    return (
      <div className="mt-1.5">
        <ProgressBar percent={pct} />
        <div className="mt-1 text-xs text-accent">
          Indexing… {source.indexed_files}
          {source.total_files !== null ? ` / ${source.total_files}` : ''} files
        </div>
      </div>
    );
  }
  if (source.status === 'idle') {
    const when = formatRelative(source.last_indexed_at);
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-emerald-500 dark:text-emerald-400">
        <CheckIcon />
        <span>
          Indexed {when} ·{' '}
          <span className="text-muted">
            {source.indexed_files.toLocaleString()} files · {source.chunk_count.toLocaleString()} chunks
          </span>
        </span>
      </div>
    );
  }
  if (source.status === 'errored') {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-rose-500 dark:text-rose-400">
        <AlertIcon />
        <span>
          {source.status_message ?? "Couldn't reach repository"}
          {source.last_indexed_at !== null ? (
            <span className="text-muted"> · last sync {formatRelative(source.last_indexed_at)}</span>
          ) : null}
        </span>
      </div>
    );
  }
  return <div className="mt-1 text-xs text-muted">{source.status}</div>;
}

function StatusRightSlot({ source }: { source: SourceRow }): ReactElement | null {
  if (source.status === 'idle') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-300">
        Synced
      </span>
    );
  }
  if (source.status === 'indexing') {
    const pct = computePercent(source.indexed_files, source.total_files);
    return (
      <span className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
        {pct}%
      </span>
    );
  }
  if (source.status === 'errored') {
    return (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white opacity-60"
        title="Retry coming soon"
      >
        <RetryIcon />
        Retry
      </button>
    );
  }
  if (source.status === 'pending') {
    return (
      <span className="inline-flex items-center rounded-full bg-bg px-2.5 py-0.5 text-xs font-medium text-muted">
        Queued
      </span>
    );
  }
  return null;
}

function ConnectorCard({
  name,
  icon,
  status,
  connectHref,
}: {
  name: string;
  icon: ReactElement;
  status: 'connected' | 'coming-soon' | 'connect';
  connectHref?: string;
}): ReactElement {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 items-center justify-center">{icon}</span>
        <span className="text-sm font-medium text-fg">{name}</span>
      </div>
      {status === 'connected' ? (
        <span className="text-xs font-medium text-emerald-500 dark:text-emerald-400">Connected</span>
      ) : status === 'connect' ? (
        <a
          href={connectHref ?? '#'}
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          Connect
        </a>
      ) : (
        <span className="rounded-md bg-bg px-2 py-1 text-xs font-medium text-muted">Coming soon</span>
      )}
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }): ReactElement {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}

/* ---------- Helpers ---------- */

function computePercent(indexed: number, total: number | null): number {
  if (total === null || total <= 0) return 0;
  return Math.min(100, Math.round((indexed / total) * 100));
}

function buildManageUrl(accountLogin: string, accountType: string, installationId: number): string {
  if (accountType === 'Organization') {
    return `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installationId}`;
  }
  return `https://github.com/settings/installations/${installationId}`;
}

function formatRelative(iso: string | null): string {
  if (iso === null) return 'never';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function readBanner(
  params: Record<string, string | string[] | undefined>,
): { kind: 'success' | 'error' | 'notice'; message: string } | null {
  const err = first(params['error']);
  if (err !== null) {
    return { kind: 'error', message: errorMessage(err) };
  }
  const notice = first(params['notice']);
  if (notice === 'install_cancelled') {
    return { kind: 'notice', message: 'Install cancelled. No repositories were connected.' };
  }
  if (first(params['installed']) === 'true') {
    return {
      kind: 'success',
      message: "GitHub connected. Repositories will appear here as they're indexed.",
    };
  }
  return null;
}

function first(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function errorMessage(code: string): string {
  const map: Record<string, string> = {
    install_init_failed: 'Could not start the install flow. Try again.',
    install_missing_params: 'GitHub redirected without the expected parameters. Try again.',
    install_bad_id: 'Invalid installation id from GitHub. Try again.',
    install_state_lookup_failed: 'Could not verify the install state. Try again.',
    install_state_unknown: 'Install state not found — it may have expired. Try again.',
    install_state_expired: 'Install state expired. Start the install again.',
    install_github_fetch_failed: 'Could not reach GitHub to confirm the installation. Try again in a minute.',
    install_persist_failed: 'Could not save the installation. Try again.',
    trello_not_configured:
      'Trello isn’t configured on this deployment. Set TRELLO_API_KEY to enable it.',
    trello_init_failed: 'Could not start the Trello connect flow. Try again.',
    atlassian_not_configured:
      'Jira & Confluence aren’t configured on this deployment. Set ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET to enable them.',
    atlassian_init_failed: 'Could not start the Atlassian connect flow. Try again.',
  };
  return map[code] ?? `Something went wrong (${code}). Try again.`;
}

/* ---------- Inline icons ---------- */

function PlusIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function GithubMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 .5C5.4.5 0 5.9 0 12.5c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.8-1.6 8.2-6.1 8.2-11.4C24 5.9 18.6.5 12 .5z" />
    </svg>
  );
}

function BranchIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 7v6a4 4 0 0 0 4 4h2" />
      <path d="M18 7v2a4 4 0 0 1-4 4h-2" />
    </svg>
  );
}

function ClockIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function AlertIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function RetryIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function SlackMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" style={{ color: 'var(--src-slack)' }}>
      <rect x="3" y="10" width="8" height="4" rx="2" />
      <rect x="13" y="10" width="8" height="4" rx="2" />
      <rect x="10" y="3" width="4" height="8" rx="2" />
      <rect x="10" y="13" width="4" height="8" rx="2" />
    </svg>
  );
}
