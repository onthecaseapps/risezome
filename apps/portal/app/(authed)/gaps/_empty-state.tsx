import type { ReactElement } from 'react';
import { BackfillButton } from './_bits';

/**
 * Knowledge-gaps empty state (plan U8 / mockup #11). Shown when the org has
 * zero visible gaps. A question-mark-in-magnifier motif, the "nothing to set
 * up" reassurance copy, and two CTAs. Managers also get a one-off backfill from
 * past meetings.
 */
export function GapsEmptyState({ isManager = false }: { isManager?: boolean }): ReactElement {
  return (
    <div className="mx-auto mt-6 flex max-w-md flex-col items-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
      <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
          <path d="M9 9.2a2 2 0 0 1 3.9.7c0 1.3-1.9 1.7-1.9 2.8" />
          <path d="M11 14.4v.01" />
        </svg>
      </span>
      <h2 className="text-lg font-semibold tracking-tight">No knowledge gaps yet</h2>
      <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">
        When Risezome can&apos;t answer a question in a meeting, it&apos;ll surface here automatically:
        merged, ranked by demand, and grouped into sections. Nothing to set up.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <a
          href="/captures"
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90"
        >
          View captures
        </a>
        <a
          href="#how-gaps-work"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40"
        >
          How gaps work
        </a>
      </div>
      {isManager ? (
        <div className="mt-5 border-t border-border/60 pt-5">
          <p className="mb-2 text-xs text-muted">Already ran meetings before this shipped?</p>
          <BackfillButton />
        </div>
      ) : null}
    </div>
  );
}
