/**
 * Hero copy column. Renders just the text + CTAs; the marketing page places
 * this beside the live demo in a split-hero grid (centered on mobile,
 * left-aligned on lg+). The background wash and section wrapper live on the
 * page so the demo shares the same hero band.
 */
export function Hero(): React.ReactElement {
  return (
    <div className="text-center lg:text-left">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        Proactive meeting copilot
      </span>

      <h1 className="mt-6 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
        Answers, before you ask.
      </h1>

      <p className="mx-auto mt-6 max-w-xl text-pretty text-lg text-muted sm:text-xl lg:mx-0">
        Risezome listens to your meeting and surfaces the pull requests, tickets, and docs that
        matter, right when they matter. No querying. No searching. No asking.
      </p>

      <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
        <a
          href="#waitlist"
          className="w-full rounded-xl bg-accent px-6 py-3 text-center font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90 sm:w-auto"
        >
          Request early access
        </a>
      </div>

      <p className="mt-6 text-sm text-muted">
        Live during the meeting · Grounded in GitHub, Jira &amp; Slack
      </p>
    </div>
  );
}
