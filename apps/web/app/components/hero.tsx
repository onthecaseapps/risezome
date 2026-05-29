export function Hero(): React.ReactElement {
  return (
    <section className="relative overflow-hidden">
      {/* Soft accent wash behind the hero. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 h-96 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_srgb,var(--accent)_18%,transparent),transparent)]"
      />
      <div className="relative mx-auto max-w-3xl px-5 pb-16 pt-20 text-center sm:px-8 sm:pb-24 sm:pt-28">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          Local-first meeting copilot
        </span>

        <h1 className="mt-6 text-balance text-4xl font-bold tracking-tight sm:text-6xl">
          The context finds you.
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted sm:text-xl">
          Upwell listens to your meeting on your own machine and surfaces the pull requests,
          tickets, and docs that matter — the moment they matter. No querying. No bot. No asking.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="#waitlist"
            className="w-full rounded-xl bg-accent px-6 py-3 text-center font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90 sm:w-auto"
          >
            Request early access
          </a>
          <a
            href="#demo"
            className="w-full rounded-xl border border-border px-6 py-3 text-center font-semibold text-fg transition-colors hover:border-accent hover:text-accent sm:w-auto"
          >
            See it live
          </a>
        </div>

        <p className="mt-6 text-sm text-muted">
          Runs locally · No bot joins your call · Grounded in GitHub, Jira &amp; Slack
        </p>
      </div>
    </section>
  );
}
