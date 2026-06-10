import type { ReactElement } from 'react';

/**
 * Placeholder for a settings category whose page hasn't been built yet
 * (Profile, Workspace, Billing). Matches the meeting-bot page header so the
 * shell reads consistently; swap the body for the real form when it lands.
 */
export function SettingsStub({ title, blurb }: { title: string; blurb: string }): ReactElement {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted">Settings</p>
        <h1 className="mt-1 text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-pretty text-muted">{blurb}</p>
      </header>
      <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center shadow-[var(--card-shadow)]">
        <p className="text-sm font-medium text-fg">Coming soon</p>
        <p className="mt-1 text-sm text-muted">This settings area isn’t available yet.</p>
      </div>
    </div>
  );
}
