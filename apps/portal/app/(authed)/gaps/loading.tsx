import type { ReactElement } from 'react';

/**
 * Route-level skeleton for Knowledge gaps — paints the page shape (header +
 * stat chips, toolbar, section cards with rows) while the server component
 * resolves its reads. Mirrors the real layout's spacing so content doesn't
 * jump on swap.
 */
export default function GapsLoading(): ReactElement {
  return (
    <div className="mx-auto w-full max-w-6xl animate-pulse px-6 py-8 sm:px-8" aria-busy="true">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="h-9 w-72 rounded-lg bg-card" />
          <div className="mt-3 h-4 w-96 max-w-full rounded bg-card" />
        </div>
        <div className="flex items-center gap-2.5">
          <div className="h-14 w-20 rounded-xl bg-card" />
          <div className="h-14 w-24 rounded-xl bg-card" />
          <div className="h-14 w-20 rounded-xl bg-card" />
        </div>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="h-10 min-w-[200px] flex-1 rounded-xl bg-card" />
        <div className="h-10 w-32 rounded-xl bg-card" />
        <div className="h-10 w-32 rounded-xl bg-card" />
        <div className="h-10 w-24 rounded-xl bg-card" />
      </div>
      <div className="flex flex-col gap-6">
        {Array.from({ length: 2 }, (_, s) => (
          <div key={s} className="rounded-2xl border border-border">
            <div className="rounded-t-2xl bg-card/40 px-4 py-2.5">
              <div className="h-5 w-40 rounded bg-card" />
            </div>
            {Array.from({ length: 3 }, (_, r) => (
              <div key={r} className="border-t border-border px-4 py-4">
                <div className="h-5 w-2/3 rounded bg-card" />
                <div className="mt-2 h-3.5 w-1/3 rounded bg-card" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
