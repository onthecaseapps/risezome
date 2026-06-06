import type { ReactElement } from 'react';
import { TrelloMark, JiraMark, ConfluenceMark } from './_source-icons';

/**
 * "Add a source" section (U5). Lists the connect affordances for providers that
 * are not already connected (a connected Trello/Atlassian shows as a card above,
 * so it drops out of this list); GitHub and Slack always appear:
 *   - "Add another GitHub org" → /sources/install (always — GitHub is one-to-many,
 *     KTD4). Re-installing on another org just creates another github_installations
 *     row, no new backend.
 *   - "Connect Trello" → /sources/trello/connect (only when not yet connected).
 *   - "Connect Jira" / "Connect Confluence" → /sources/atlassian/connect (only when
 *     Atlassian is not yet connected; one OAuth grants both, hence two rows sharing
 *     the same connect URL — mirrors the old Connectors grid).
 *   - "Connect Slack" → a disabled "coming soon" stub (KTD6); no Slack ingestion.
 *
 * Plus the footer note: GitHub supports multiple org connections; Jira, Trello and
 * Slack connect one workspace each.
 */
export function AddSourceSection({
  trelloConnected,
  atlassianConnected,
}: {
  trelloConnected: boolean;
  atlassianConnected: boolean;
}): ReactElement {
  return (
    <div className="mt-10">
      <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Add a source</div>
      <div className="flex flex-col gap-3">
        <AddRow
          icon={<GithubMark className="h-5 w-5 text-fg" />}
          name="GitHub"
          description="Connect another GitHub org to index its repositories."
          action={<ConnectLink href="/sources/install" label="+ Add another org" />}
        />
        {!trelloConnected && (
          <AddRow
            icon={<TrelloMark />}
            name="Trello"
            description="Connect a Trello workspace to index its boards and cards."
            action={<ConnectLink href="/sources/trello/connect" label="+ Connect Trello" />}
          />
        )}
        {!atlassianConnected && (
          <>
            <AddRow
              icon={<JiraMark />}
              name="Jira"
              description="Connect an Atlassian site to index its Jira projects."
              action={<ConnectLink href="/sources/atlassian/connect" label="+ Connect Jira" />}
            />
            <AddRow
              icon={<ConfluenceMark />}
              name="Confluence"
              description="Connect an Atlassian site to index its Confluence spaces."
              action={<ConnectLink href="/sources/atlassian/connect" label="+ Connect Confluence" />}
            />
          </>
        )}
        <AddRow
          icon={<SlackMark />}
          name="Slack"
          description="Link your Slack workspace to search channel history."
          action={
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Coming soon"
              className="cursor-not-allowed rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-medium text-muted opacity-60"
            >
              + Connect Slack
            </button>
          }
        />
      </div>
      <p className="mt-4 flex items-start gap-2 text-xs text-muted">
        <InfoGlyph />
        <span>
          GitHub supports multiple org connections — add as many as you need. Jira, Trello and Slack
          connect one workspace each.
        </span>
      </p>
    </div>
  );
}

function ConnectLink({ href, label }: { href: string; label: string }): ReactElement {
  return (
    <a
      href={href}
      className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-accent/40"
    >
      {label}
    </a>
  );
}

function AddRow({
  icon,
  name,
  description,
  action,
}: {
  icon: ReactElement;
  name: string;
  description: string;
  action: ReactElement;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-bg">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">{name}</div>
          <div className="truncate text-xs text-muted">{description}</div>
        </div>
      </div>
      <div className="flex-none">{action}</div>
    </div>
  );
}

function GithubMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.4.5 0 5.9 0 12.5c0 5.3 3.4 9.8 8.2 11.4.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.8-1.6 8.2-6.1 8.2-11.4C24 5.9 18.6.5 12 .5z" />
    </svg>
  );
}

function SlackMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-muted" fill="currentColor" aria-hidden="true">
      <rect x="3" y="10" width="8" height="4" rx="2" />
      <rect x="13" y="10" width="8" height="4" rx="2" />
      <rect x="10" y="3" width="4" height="8" rx="2" />
      <rect x="10" y="13" width="4" height="8" rx="2" />
    </svg>
  );
}

function InfoGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-none text-muted" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}
