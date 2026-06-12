import type { ReactElement } from 'react';
import { requireAdmin } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { decryptForOrgFromBytea, EnvelopeCryptoError } from '@risezome/crypto';
import { requireTrelloApiKey } from '../../_lib/trello';
import { listBoards } from '../../_lib/trello-client';
import { getValidAtlassianToken } from '../../_lib/atlassian-token';
import { listConfluenceSpaces, listJiraProjects } from '../../_lib/atlassian-client';
import { SourcesAutoRefresh } from './_auto-refresh';
import { ConnectionCard, type ConnectionCardData } from './_connection-card';
import { AddSourceSection } from './_add-source';
import { ConfigTeamSelector, type ConfigTeam } from './_config-team-selector';
import { TrelloMark, JiraMark, ConfluenceMark } from './_source-icons';
import type { SourceItem } from './_source-item-list';
import { buildGithubItems, type GithubSourceRow } from './_github-items';

/**
 * Sources — the per-team source editor (redesign). Pick a team to configure via
 * the top-right "Configuring {team}" selector (?team=<teamId>, KTD1), then each
 * connection renders as a card: GitHub once per installation (fixing the old
 * installRows[0] bug), plus the single Jira/Confluence/Trello. Each card expands
 * to an All/Selected checklist of its repos/projects/spaces/boards; checking an
 * item adds it to the selected team's sources (the shipped team_sources refcount
 * lifecycle), unchecking removes it. The page stays requireAdmin-gated.
 *
 * Read model (all org-scoped):
 *   - teams (non-archived) → the config-team selector + the resolved selected team
 *   - team_sources for the selected team → which checklist items are checked
 *   - github_installations (ALL, removed_at is null) + their `sources` rows
 *   - trello/atlassian connections + their `sources` rows + available items
 */

interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: string;
  suspended_at: string | null;
}

interface ConnectionSourceRow {
  id: string;
  kind?: string;
  display_name: string | null;
  external_id: string | null;
  status: string;
  indexed_files: number;
  total_files: number | null;
  excluded_count?: number;
  corpus_policy?: { preset?: string } | null;
}

export default async function SourcesPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { orgId } = await requireAdmin();
  const searchParams = await props.searchParams;

  const supabase = await createServerClient();
  const serviceRole = createServiceRoleClient();

  // ── Teams (config-team selector) ──────────────────────────────────────────
  const { data: teamRows } = await supabase
    .from('teams')
    .select('team_id, name')
    .eq('org_id', orgId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });
  const teams: ConfigTeam[] = (teamRows ?? []).map((t) => ({
    id: t.team_id as string,
    name: t.name as string,
  }));

  // Resolve the selected team from ?team=, validated against the org's teams;
  // default to the first team (KTD1).
  const requestedTeam = first(searchParams['team']);
  const selectedTeamId =
    requestedTeam !== null && teams.some((t) => t.id === requestedTeam)
      ? requestedTeam
      : teams[0]?.id ?? null;

  // ── The selected team's current sources (checked set) + paused set ────────
  // `teamSourceIds` = membership (drives the checkboxes); `disabledSourceIds` =
  // sources the team has PAUSED (team_sources.enabled = false) — kept + indexed
  // but excluded from retrieval. Drives the top-level enable/disable toggle.
  const teamSourceIds = new Set<string>();
  const disabledSourceIds = new Set<string>();
  // The team's per-source VIEW policy preset (query-time filtering) — drives the
  // filtering editor's current preset, replacing the shared source policy.
  const viewPresetBySource = new Map<string, string | null>();
  if (selectedTeamId !== null) {
    const { data: tsRows } = await supabase
      .from('team_sources')
      .select('source_id, enabled, view_policy')
      .eq('team_id', selectedTeamId);
    for (const r of tsRows ?? []) {
      const id = r.source_id as string;
      teamSourceIds.add(id);
      if ((r.enabled as boolean) === false) disabledSourceIds.add(id);
      const vp = r.view_policy as { preset?: string } | null;
      viewPresetBySource.set(id, vp?.preset ?? null);
    }
  }

  // ── GitHub: ALL installations + their repo sources ────────────────────────
  const { data: installRows } = await supabase
    .from('github_installations')
    .select('installation_id, account_login, account_type, suspended_at')
    .eq('org_id', orgId)
    .is('removed_at', null)
    .order('account_login', { ascending: true });
  const installations = (installRows ?? []) as InstallationRow[];

  // NOTE: removed (de-indexed) repos are intentionally INCLUDED. GitHub has no
  // live repo listing here (unlike Trello/Atlassian, whose removed sources
  // reappear via their live board/project list), so filtering removed rows out
  // would make a de-indexed repo vanish from the page with no way to re-select
  // it. buildGithubItems offers removed repos as available, re-selectable items;
  // re-selecting revives the source via addSourceToTeam.
  const { data: githubSourceRows } = installations.length
    ? await supabase
        .from('sources')
        .select('id, repo_full_name, installation_id, status, indexed_files, total_files, excluded_count, corpus_policy')
        .eq('org_id', orgId)
        .not('installation_id', 'is', null)
        .order('repo_full_name', { ascending: true })
    : { data: [] as GithubSourceRow[] };
  const githubSources = (githubSourceRows ?? []) as GithubSourceRow[];

  // Org-default corpus filtering policy (absent row ⇒ 'recommended' in code).
  const { data: orgPolicyRow } = await supabase
    .from('org_corpus_policy')
    .select('preset')
    .eq('org_id', orgId)
    .maybeSingle();
  const orgPolicyPreset = (orgPolicyRow?.preset as string | undefined) ?? 'recommended';

  // ── Trello: connection + sources + available boards ───────────────────────
  // The token is encrypted at rest (token_enc; the plaintext `token` column was
  // dropped by 20260607010000_encrypt_trello_token). Select token_enc and decrypt
  // it for the live board listing — selecting the dropped `token` 400s the query,
  // which silently nulls the row and shows "Connect Trello" despite a stored
  // connection.
  const { data: trelloConnRow } = await serviceRole
    .from('trello_connections')
    .select('id, token_enc, username')
    .eq('org_id', orgId)
    .maybeSingle();

  let trelloSources: ConnectionSourceRow[] = [];
  let trelloBoards: Array<{ id: string; name: string }> = [];
  if (trelloConnRow !== null) {
    const { data: tSrc } = await supabase
      .from('sources')
      .select('id, display_name, external_id, status, indexed_files, total_files, excluded_count, corpus_policy')
      .eq('org_id', orgId)
      .eq('kind', 'trello')
      .neq('status', 'removed')
      .order('display_name', { ascending: true });
    trelloSources = (tSrc ?? []) as ConnectionSourceRow[];

    // Decrypt the token for the live board listing. DEGRADE on a crypto failure
    // (KMS blip): skip board listing but keep the connection shown.
    let trelloToken: string | null = null;
    try {
      trelloToken = await decryptForOrgFromBytea(orgId, trelloConnRow.token_enc as string);
    } catch (err) {
      if (!(err instanceof EnvelopeCryptoError)) throw err;
      console.error('[sources] trello token decrypt failed:', err);
    }
    if (trelloToken !== null) {
      try {
        const boards = await listBoards({ token: trelloToken, apiKey: requireTrelloApiKey() });
        trelloBoards = boards.map((b) => ({ id: b.id, name: b.name }));
      } catch {
        // Board listing failed (e.g. revoked token); fall back to indexed-only.
      }
    }
  }

  // ── Atlassian: connection + jira/confluence sources + available items ─────
  const { data: atlassianConnRow } = await serviceRole
    .from('atlassian_connections')
    .select('id')
    .eq('org_id', orgId)
    .maybeSingle();

  let atlassianSources: ConnectionSourceRow[] = [];
  let jiraProjects: Array<{ id: string; name: string }> = [];
  let confluenceSpaces: Array<{ id: string; name: string }> = [];
  // Atlassian site/host name isn't surfaced by the connection read yet; the
  // badge is left null until a multi-site model lands (deferred, see plan scope).
  const atlassianSite: string | null = null;
  if (atlassianConnRow !== null) {
    const { data: aSrc } = await supabase
      .from('sources')
      .select('id, kind, display_name, external_id, status, indexed_files, total_files, excluded_count, corpus_policy')
      .eq('org_id', orgId)
      .in('kind', ['jira', 'confluence'])
      .neq('status', 'removed')
      .order('display_name', { ascending: true });
    atlassianSources = (aSrc ?? []) as ConnectionSourceRow[];
    try {
      const token = await getValidAtlassianToken(orgId, serviceRole);
      const client = { accessToken: token.accessToken, cloudId: token.cloudId };
      // Jira and Confluence are independent products: a site can have one
      // without the other (a Confluence-only site 404s on the Jira API, and
      // vice versa). Settle them separately so one product's failure doesn't
      // blank out the other's available items.
      const [projects, spaces] = await Promise.allSettled([
        listJiraProjects(client),
        listConfluenceSpaces(client),
      ]);
      // A product that isn't provisioned on the site 404s here — that's an
      // expected condition (e.g. Confluence-only sites have no Jira), so log at
      // warn level. Passing the Error object to console.error would also trip
      // Next's dev error overlay for a handled, routine case.
      if (projects.status === 'fulfilled') {
        jiraProjects = projects.value.map((p) => ({ id: p.key, name: p.name }));
      } else {
        console.warn('[sources.atlassian] listJiraProjects unavailable:', String(projects.reason));
      }
      if (spaces.status === 'fulfilled') {
        confluenceSpaces = spaces.value.map((s) => ({ id: s.id, name: s.name }));
      } else {
        console.warn('[sources.atlassian] listConfluenceSpaces unavailable:', String(spaces.reason));
      }
    } catch {
      // Token stale (reconnect needed) — fall back to indexed-only items.
    }
  }

  // ── Build connection cards ────────────────────────────────────────────────
  const cards: ConnectionCardData[] = [];

  for (const inst of installations) {
    const repos = githubSources.filter((s) => s.installation_id === inst.installation_id);
    const { items, selected } = buildGithubItems(repos, teamSourceIds, inst.installation_id, viewPresetBySource);
    cards.push({
      provider: 'github',
      cardKey: `gh-${inst.installation_id}`,
      name: 'GitHub',
      badge: inst.account_login,
      icon: <GithubMark className="h-5 w-5 text-fg" />,
      suspended: inst.suspended_at !== null,
      manageUrl: buildManageUrl(inst.account_login, inst.account_type, inst.installation_id),
      items,
      selectedExternalIds: selected,
      enabled: connectionEnabled(repos, teamSourceIds, disabledSourceIds),
      installationId: inst.installation_id,
    });
  }

  if (atlassianConnRow !== null) {
    cards.push(
      buildAtlassianCard('jira', 'Jira', <JiraMark />, atlassianSources, jiraProjects, teamSourceIds, disabledSourceIds, viewPresetBySource, atlassianSite),
    );
    cards.push(
      buildAtlassianCard(
        'confluence',
        'Confluence',
        <ConfluenceMark />,
        atlassianSources,
        confluenceSpaces,
        teamSourceIds,
        disabledSourceIds,
        viewPresetBySource,
        atlassianSite,
      ),
    );
  }

  if (trelloConnRow !== null) {
    const items = buildItems(trelloSources, trelloBoards, teamSourceIds, viewPresetBySource);
    cards.push({
      provider: 'trello',
      cardKey: 'trello',
      name: 'Trello',
      badge: (trelloConnRow.username as string | null) ?? null,
      icon: <TrelloMark />,
      manageUrl: '/sources/trello/connect',
      items: items.items,
      selectedExternalIds: items.selected,
      enabled: connectionEnabled(trelloSources, teamSourceIds, disabledSourceIds),
    });
  }

  // Every card surfaces the workspace default preset (for the "Inherit" label
  // in its filtering editor).
  for (const c of cards) c.orgDefaultPreset = orgPolicyPreset;

  const banner = readBanner(searchParams);
  const allItems = cards.flatMap((c) => c.items);
  const hasInflight = allItems.some((it) => it.status === 'pending' || it.status === 'indexing');
  const totalSelected = teamSourceIds.size;
  const selectedTeamName = teams.find((t) => t.id === selectedTeamId)?.name ?? null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <SourcesAutoRefresh shouldPoll={hasInflight} />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Sources</h1>
          <p className="mt-2 max-w-xl text-pretty text-muted">
            Configured per team. Pick whole accounts or specific repos, boards and projects for the
            team to search.
          </p>
        </div>
        {teams.length > 0 && selectedTeamId !== null ? (
          <ConfigTeamSelector teams={teams} selectedTeamId={selectedTeamId} />
        ) : null}
      </header>

      {banner !== null ? (
        <div
          className={
            banner.kind === 'error'
              ? 'mb-6 rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-200'
              : 'mb-6 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-fg'
          }
        >
          {banner.message}
        </div>
      ) : null}

      {teams.length === 0 ? (
        <NoTeamsState />
      ) : cards.length === 0 ? (
        <>
          <EmptyConnectState />
          <AddSourceSection
            trelloConnected={trelloConnRow !== null}
            atlassianConnected={atlassianConnRow !== null}
          />
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
            <span>Connected · {cards.length}</span>
            {selectedTeamName !== null ? (
              <span>
                · {totalSelected} searched by {selectedTeamName}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
            {cards.map((card) => (
              // Key on the team so switching teams REMOUNTS the card with fresh
              // state. The card's selected/savedSelected/enabled are useState
              // initializers (run once per instance); without the team in the
              // key, React reuses the instance across a `?team=` switch and the
              // card keeps the previous team's checkmarks/toggle even though the
              // server passed the new team's data.
              <ConnectionCard key={`${selectedTeamId!}:${card.cardKey}`} teamId={selectedTeamId!} data={card} />
            ))}
          </div>
          <AddSourceSection
            trelloConnected={trelloConnRow !== null}
            atlassianConnected={atlassianConnRow !== null}
          />
        </>
      )}
    </div>
  );
}

/* ---------- Card builders ---------- */

function buildItems(
  sources: ConnectionSourceRow[],
  available: Array<{ id: string; name: string }>,
  teamSourceIds: Set<string>,
  viewPresetBySource: Map<string, string | null>,
): { items: SourceItem[]; selected: string[] } {
  const seen = new Set<string>();
  const items: SourceItem[] = [];

  // Indexed sources first (carry status + counts), then available-but-unindexed.
  for (const s of sources) {
    const ext = s.external_id ?? s.id;
    seen.add(ext);
    items.push({
      key: s.id,
      sourceId: s.id,
      externalId: ext,
      label: s.display_name ?? ext,
      count: s.indexed_files,
      total: s.total_files,
      status: s.status,
      excluded: s.excluded_count ?? 0,
      // The TEAM's view preset (query-time filtering), not the shared source
      // policy — so the filtering editor shows this team's view.
      presetKey: viewPresetBySource.get(s.id) ?? null,
    });
  }
  for (const a of available) {
    if (seen.has(a.id)) continue;
    items.push({ key: `avail-${a.id}`, externalId: a.id, label: a.name, count: null, total: null, status: null });
  }

  items.sort((x, y) => x.label.localeCompare(y.label));
  const selected = sources.filter((s) => teamSourceIds.has(s.id)).map((s) => s.external_id ?? s.id);
  return { items, selected };
}

/** A connection's top-level enable state: ON only when it has selected sources
 *  and none of them are paused (team_sources.enabled = false). With nothing
 *  selected the toggle is OFF (and disabled in the UI — there's nothing to pause). */
function connectionEnabled(
  sources: Array<{ id: string }>,
  teamSourceIds: Set<string>,
  disabledSourceIds: Set<string>,
): boolean {
  const selected = sources.filter((s) => teamSourceIds.has(s.id));
  return selected.length > 0 && selected.every((s) => !disabledSourceIds.has(s.id));
}

function buildAtlassianCard(
  kind: 'jira' | 'confluence',
  name: string,
  icon: ReactElement,
  atlassianSources: ConnectionSourceRow[],
  available: Array<{ id: string; name: string }>,
  teamSourceIds: Set<string>,
  disabledSourceIds: Set<string>,
  viewPresetBySource: Map<string, string | null>,
  site: string | null,
): ConnectionCardData {
  const kindSources = atlassianSources.filter((s) => (s.kind ?? '') === kind);
  const { items, selected } = buildItems(kindSources, available, teamSourceIds, viewPresetBySource);
  return {
    provider: kind,
    cardKey: kind,
    name,
    badge: site,
    icon,
    manageUrl: '/sources/atlassian/connect',
    items,
    selectedExternalIds: selected,
    enabled: connectionEnabled(kindSources, teamSourceIds, disabledSourceIds),
  };
}

/* ---------- Empty states ---------- */

function NoTeamsState(): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center shadow-[var(--card-shadow)]">
      <h2 className="text-lg font-semibold tracking-tight">No teams yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Sources are configured per team. Create a team first on the{' '}
        <a href="/settings/teams" className="text-accent hover:underline">Teams &amp; members</a> page, then
        come back here to choose what it searches.
      </p>
    </div>
  );
}

function EmptyConnectState(): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center shadow-[var(--card-shadow)]">
      <h2 className="text-lg font-semibold tracking-tight">No connections yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Connect GitHub, Jira, Confluence or Trello to start indexing, then choose which repos,
        projects, spaces or boards this team searches.
      </p>
    </div>
  );
}

/* ---------- Helpers ---------- */

function buildManageUrl(accountLogin: string, accountType: string, installationId: number): string {
  if (accountType === 'Organization') {
    return `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installationId}`;
  }
  return `https://github.com/settings/installations/${installationId}`;
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

function GithubMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.4.5 0 5.9 0 12.5c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.8-1.6 8.2-6.1 8.2-11.4C24 5.9 18.6.5 12 .5z" />
    </svg>
  );
}
