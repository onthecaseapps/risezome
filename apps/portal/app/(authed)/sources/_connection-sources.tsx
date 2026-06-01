'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { reindexSourceAction } from './reindex-action';
import { TrelloBoardPicker } from './_trello-board-picker';
import { AtlassianPickers } from './_atlassian-pickers';

export interface ConnectionSourceRow {
  id: string;
  kind?: string;
  display_name: string | null;
  status: string;
  status_message: string | null;
  indexed_files: number;
  total_files: number | null;
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

  const count = source.indexed_files;
  const total = source.total_files;
  const noun = ITEM_NOUN[source.kind ?? 'trello'] ?? 'item';
  const plural = count === 1 ? noun : `${noun}s`;
  const busy = source.status === 'indexing' || source.status === 'pending';

  const statusLine =
    source.status === 'idle'
      ? `${count} ${plural} indexed`
      : source.status === 'indexing'
        ? `Indexing… ${count}${total !== null ? ` / ${total}` : ''} ${noun}s`
        : source.status === 'errored'
          ? (source.status_message ?? 'Indexing failed')
          : 'Queued';

  function handleReindex(): void {
    setError(null);
    const fd = new FormData();
    fd.set('sourceId', source.id);
    startTransition(async () => {
      const res = await reindexSourceAction(fd);
      if (!res.ok) setError(`Failed (${res.error})`);
      else setOpen(false);
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-fg">{source.display_name ?? 'Source'}</div>
        <div className="mt-0.5 text-xs text-muted">{statusLine}</div>
      </div>

      <div className="relative flex-shrink-0">
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
              className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={handleReindex}
                disabled={busy || pending}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
                title={busy ? 'Indexer is already running — wait for it to finish' : undefined}
              >
                {pending ? <Spinner /> : <RetryIcon />}
                {pending ? 'Queuing…' : 'Re-index'}
              </button>
              {onManage !== undefined ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onManage();
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg hover:bg-bg"
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
