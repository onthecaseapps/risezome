import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';

/**
 * Sources view. Placeholder until U4 (GitHub App install + per-source
 * status). For now: confirms auth+org+routing all flow, shows the user
 * which org they're scoped to.
 */
export default async function SourcesPage(): Promise<ReactElement> {
  const { orgName } = await requireAuthedUserWithOrg();

  return (
    <main>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          You&apos;re viewing <strong>{orgName}</strong>. GitHub App installation + indexed
          repos coming in the next unit (U4).
        </p>
      </header>

      <div className="rounded-md border border-[var(--border)] bg-[var(--card-bg)] p-6 text-sm text-[var(--muted)]">
        Placeholder — U4 implementation will replace this with the GitHub App install
        button and per-source status rows.
      </div>
    </main>
  );
}
