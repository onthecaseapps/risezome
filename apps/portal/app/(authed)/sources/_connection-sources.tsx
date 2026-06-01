'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { reindexSourceAction } from './reindex-action';
import { TrelloBoardPicker } from './_trello-board-picker';
import { AtlassianPickers } from './_atlassian-pickers';
import { SourceMark } from './_source-icons';

export interface ConnectionSourceRow {
  id: string;
  kind?: string;
  display_name: string | null;
  status: string;
  status_message: string | null;
  indexed_files: number;
  total_files: number | null;
  last_indexed_at: string | null;
}

type PickerData =
  | { kind: 'trello'; boards: { id: string; name: string }[] }
  | { kind: 'atlassian'; projects: { id: string; name: string }[]; spaces: { id: string; name: string }[] };

const ITEM_NOUN: Record<string, string> = { trello: 'card', jira: 'issue', confluence: 'page' };

/**
 * Renders a connection-backed source group (Trello boards, or Jira/Confluence):
 * the indexed sources as rows — each with an in-row ⋮ menu (Re-index + Manage)
 * — plus the add-more picker. The picker is hidden once anything is indexed and
 * re-opened from a row's "Manage …" menu item; on first-time setup (nothing
 * indexed yet) it shows inline.
 */
export function ConnectionSources({
  sources,
  manageLabel,
  picker,
}: {
  sources: ConnectionSourceRow[];
  manageLabel: string;
  picker: PickerData;
}): ReactElement {
  const hasMoreToAdd =
    picker.kind === 'trello'
      ? picker.boards.length > 0
      : picker.projects.length > 0 || picker.spaces.length > 0;
  const [managing, setManaging] = useState(sources.length === 0);

  return (
    <>
      {sources.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-3">
          {sources.map((s) => (
            <li key={s.id}>
              <SourceRowCard
                source={s}
                manageLabel={manageLabel}
                onManage={hasMoreToAdd ? () => setManaging(true) : undefined}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {managing && hasMoreToAdd ? (
        picker.kind === 'trello' ? (
          <TrelloBoardPicker
            boards={picker.boards}
            onDone={sources.length > 0 ? () => setManaging(false) : undefined}
          />
        ) : (
          <AtlassianPickers
            projects={picker.projects}
            spaces={picker.spaces}
            onDone={sources.length > 0 ? () => setManaging(false) : undefined}
          />
        )
      ) : null}
    </>
  );
}

function SourceRowCard({
  source,
  manageLabel,
  onManage,
}: {
  source: ConnectionSourceRow;
  manageLabel: string;
  onManage?: (() => void) | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const kind = source.kind ?? 'trello';
  const noun = ITEM_NOUN[kind] ?? 'item';
  const isErrored = source.status === 'errored';
  const busy = source.status === 'indexing' || source.status === 'pending';

  function handleReindex(reindexMode: 'delta' | 'full'): void {
    setError(null);
    const fd = new FormData();
    fd.set('sourceId', source.id);
    fd.set('mode', reindexMode);
    startTransition(async () => {
      const res = await reindexSourceAction(fd);
      if (!res.ok) setError(`Failed (${res.error})`);
      else setOpen(false);
    });
  }

  return (
    <div
      className={`flex items-center gap-4 rounded-xl border bg-card p-4 ${
        isErrored ? 'border-rose-400/40' : 'border-border'
      }`}
    >
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-bg">
        <SourceMark kind={kind} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{source.display_name ?? 'Source'}</div>
        <SourceStatusLine source={source} noun={noun} />
      </div>

      <div className="relative flex flex-shrink-0 items-center gap-2">
        <SourceStatusBadge source={source} />
        <button
          type="button"
          aria-label="Source actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          disabled={pending}
          className="rounded-md p-1.5 text-muted hover:bg-bg disabled:opacity-40"
        >
          <KebabIcon />
        </button>

        {open ? (
          <>
            {/* Transparent overlay catches outside clicks to close the menu. */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => handleReindex('delta')}
                disabled={busy || pending}
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
                title={busy ? 'Indexer is already running — wait for it to finish' : undefined}
              >
                {pending ? <Spinner /> : <RetryIcon />}
                <span className="flex flex-col">
                  <span>{pending ? 'Queuing…' : 'Reindex (delta)'}</span>
                  <span className="text-[11px] text-muted">New &amp; changed only</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleReindex('full')}
                disabled={busy || pending}
                className="flex w-full items-start gap-2 border-t border-border px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
                title={busy ? 'Indexer is already running — wait for it to finish' : undefined}
              >
                {pending ? <Spinner /> : <RetryIcon />}
                <span className="flex flex-col">
                  <span>{pending ? 'Queuing…' : 'Reindex (full)'}</span>
                  <span className="text-[11px] text-muted">Also removes deleted {noun}s</span>
                </span>
              </button>
              {onManage !== undefined ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onManage();
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-fg hover:bg-bg"
                >
                  <GearIcon />
                  {manageLabel}
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {error !== null ? (
          <span className="absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SourceStatusLine({ source, noun }: { source: ConnectionSourceRow; noun: string }): ReactElement {
  const count = source.indexed_files;
  const plural = count === 1 ? noun : `${noun}s`;
  if (source.status === 'idle') {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-emerald-500 dark:text-emerald-400">
        <CheckIcon />
        <span>
          Indexed {formatRelative(source.last_indexed_at)} ·{' '}
          <span className="text-muted">
            {count.toLocaleString()} {plural}
          </span>
        </span>
      </div>
    );
  }
  if (source.status === 'indexing') {
    return (
      <div className="mt-1 text-xs text-accent">
        Indexing… {count}
        {source.total_files !== null ? ` / ${source.total_files}` : ''} {noun}s
      </div>
    );
  }
  if (source.status === 'errored') {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-rose-500 dark:text-rose-400">
        <AlertIcon />
        <span>
          {source.status_message ?? 'Indexing failed'}
          {source.last_indexed_at !== null ? (
            <span className="text-muted"> · last sync {formatRelative(source.last_indexed_at)}</span>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
      <ClockIcon />
      Waiting to index
    </div>
  );
}

function SourceStatusBadge({ source }: { source: ConnectionSourceRow }): ReactElement | null {
  if (source.status === 'idle') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-300">
        Synced
      </span>
    );
  }
  if (source.status === 'indexing') {
    return (
      <span className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
        Indexing
      </span>
    );
  }
  if (source.status === 'errored') {
    return (
      <span className="inline-flex items-center rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-300">
        Failed
      </span>
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

function formatRelative(iso: string | null): string {
  if (iso === null) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function CheckIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ClockIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function AlertIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}

function KebabIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function RetryIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function GearIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function Spinner(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
