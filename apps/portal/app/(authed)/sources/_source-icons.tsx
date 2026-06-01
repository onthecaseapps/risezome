import type { ReactElement } from 'react';

/**
 * Source brand marks, shared between the Sources page (connector cards) and the
 * source rows (ConnectionSources) so the iconography stays consistent.
 */

export function TrelloMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" style={{ color: 'var(--src-trello, var(--src-jira))' }}>
      <path d="M21 0H3C1.343 0 0 1.343 0 3v18c0 1.657 1.343 3 3 3h18c1.657 0 3-1.343 3-3V3c0-1.657-1.343-3-3-3zM10.5 17.25A1.25 1.25 0 0 1 9.25 18.5h-3.5A1.25 1.25 0 0 1 4.5 17.25V5.75A1.25 1.25 0 0 1 5.75 4.5h3.5A1.25 1.25 0 0 1 10.5 5.75v11.5zm9-6A1.25 1.25 0 0 1 18.25 12.5h-3.5A1.25 1.25 0 0 1 13.5 11.25v-5.5A1.25 1.25 0 0 1 14.75 4.5h3.5a1.25 1.25 0 0 1 1.25 1.25v5.5z" />
    </svg>
  );
}

export function JiraMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" style={{ color: 'var(--src-jira)' }}>
      <path d="M12 1.5 1.5 12 12 22.5 22.5 12 12 1.5zm0 4.2 6.3 6.3-6.3 6.3-6.3-6.3 6.3-6.3z" />
    </svg>
  );
}

export function ConfluenceMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" style={{ color: 'var(--src-confluence)' }}>
      <path d="M3 17.5c3-4 6-6 9-6s5 1.5 8 5c.4.5.2 1-.4 1.3l-3 1.4c-.5.2-1 0-1.3-.4-1.4-2-2.6-2.7-4-2.7-1.7 0-3.2 1.1-5 3.5-.3.4-.9.5-1.3.2L3.4 18.8c-.5-.3-.6-.9-.4-1.3zM21 6.5c-3 4-6 6-9 6s-5-1.5-8-5c-.4-.5-.2-1 .4-1.3l3-1.4c.5-.2 1 0 1.3.4 1.4 2 2.6 2.7 4 2.7 1.7 0 3.2-1.1 5-3.5.3-.4.9-.5 1.3-.2l2.3 1.5c.5.3.6.9.4 1.5z" />
    </svg>
  );
}

/** Per-kind source mark dispatcher used by the connector source rows. */
export function SourceMark({ kind }: { kind: string }): ReactElement {
  if (kind === 'jira') return <JiraMark />;
  if (kind === 'confluence') return <ConfluenceMark />;
  return <TrelloMark />;
}
