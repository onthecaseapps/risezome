import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';

/**
 * Sources view. Placeholder until U4b (GitHub App install + per-source
 * status). For now: confirms auth+org+routing all flow, shows which org
 * we're scoped to.
 */
export default async function SourcesPage(): Promise<ReactElement> {
  const { orgName } = await requireAuthedUserWithOrg();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
          <p className="mt-1.5 text-sm text-muted">
            What Risezome searches when it grounds an answer.
          </p>
        </div>
      </header>

      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted">
          You&apos;re viewing <span className="font-medium text-fg">{orgName}</span>.
        </p>
        <p className="mt-2 text-sm text-muted">
          GitHub App installation + indexed repos arrive in U4b.
        </p>
      </div>
    </div>
  );
}
