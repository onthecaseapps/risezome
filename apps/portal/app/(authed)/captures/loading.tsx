import type { ReactElement } from 'react';

/**
 * Route-level skeleton for Captures — the page blocks on meetings + recap
 * decryption + stats, so paint the page shape (header, toolbar, card grid)
 * immediately instead of a blank main area. Mirrors the real layout's spacing
 * so content doesn't jump on swap.
 */
export default function CapturesLoading(): ReactElement {
  return (
    <div className="mx-auto w-full max-w-6xl animate-pulse px-6 py-8 sm:px-8" aria-busy="true">
      <div className="mb-7">
        <div className="h-9 w-56 rounded-lg bg-card" />
        <div className="mt-3 h-4 w-96 max-w-full rounded bg-card" />
      </div>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <div className="h-10 min-w-[220px] flex-1 rounded-xl bg-card" />
        <div className="h-10 w-32 rounded-xl bg-card" />
        <div className="h-10 w-28 rounded-xl bg-card" />
        <div className="h-10 w-28 rounded-xl bg-card" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-48 rounded-2xl border border-border bg-card/50" />
        ))}
      </div>
    </div>
  );
}
