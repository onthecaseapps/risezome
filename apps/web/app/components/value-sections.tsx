interface Beat {
  readonly title: string;
  readonly body: string;
  readonly icon: React.ReactElement;
}

function ShieldIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M12 3 5 6v6c0 4 3 6.5 7 9 4-2.5 7-5 7-9V6l-7-3Z"
        strokeLinejoin="round"
      />
      <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlugIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 3v5M15 3v5" strokeLinecap="round" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" strokeLinejoin="round" />
      <path d="M12 17v4" strokeLinecap="round" />
    </svg>
  );
}

function LoopIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const BEATS: readonly Beat[] = [
  {
    title: 'Local-first & private',
    body: 'Upwell runs on your machine. No bot joins the call, and audio never leaves your laptop — capture happens locally for Zoom, Meet, Teams, or a huddle alike.',
    icon: <ShieldIcon />,
  },
  {
    title: 'Grounded in your tools',
    body: "Cards pull straight from GitHub, Jira, and Slack — the PR's real status, the ticket's real owner, the doc that actually answers the question. Not a guess.",
    icon: <PlugIcon />,
  },
  {
    title: 'Closes the doc gap',
    body: "When nothing answers a question, Upwell captures it with its context and turns it into a doc or ticket — so the same gap stops resurfacing next week.",
    icon: <LoopIcon />,
  },
];

const STEPS: readonly { readonly n: string; readonly title: string; readonly body: string }[] = [
  {
    n: '01',
    title: 'Start it before your call',
    body: 'A background process captures system + mic audio locally. No bot, no meeting link, nothing to install for other attendees.',
  },
  {
    n: '02',
    title: 'It listens and grounds',
    body: 'A rolling transcript is matched against your connected sources in real time — and against the questions being asked out loud.',
  },
  {
    n: '03',
    title: 'Context surfaces, gaps get logged',
    body: 'Relevant cards appear in a HUD as the meeting moves. Questions nothing can answer are captured to feed back into your docs.',
  },
];

export function ValueSections(): React.ReactElement {
  return (
    <>
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <div className="grid gap-6 sm:grid-cols-3">
          {BEATS.map((beat) => (
            <div
              key={beat.title}
              className="rounded-2xl border border-border bg-card/40 p-6"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border text-accent">
                <span className="h-5 w-5">{beat.icon}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold tracking-tight">{beat.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{beat.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <div className="mb-10 text-center">
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            How it works
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted">
            Three steps, then it stays out of your way until it has something worth showing.
          </p>
        </div>
        <ol className="grid gap-6 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n} className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="font-mono text-sm font-semibold text-accent">{step.n}</div>
              <h3 className="mt-2 text-base font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
