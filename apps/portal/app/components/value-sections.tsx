interface Beat {
  readonly title: string;
  readonly body: string;
  readonly icon: React.ReactElement;
}

function BoltIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" strokeLinejoin="round" strokeLinecap="round" />
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
    title: 'Live, not after the fact',
    body: 'Context shows up during the meeting, while it can still change the decision, not buried in a summary you read tomorrow. The bot joins your Zoom and Google Meet calls.',
    icon: <BoltIcon />,
  },
  {
    title: 'Grounded in your tools',
    body: "Answers pull straight from GitHub, Jira, and Slack: the PR's real status, the ticket's real owner, the doc that actually answers the question. Cited, not guessed.",
    icon: <PlugIcon />,
  },
  {
    title: 'Closes the doc gap',
    body: "When nothing answers a question, Risezome captures it with its context and turns it into a doc or ticket, so the same gap stops resurfacing next week.",
    icon: <LoopIcon />,
  },
];

const STEPS: readonly { readonly n: string; readonly title: string; readonly body: string }[] = [
  {
    n: '01',
    title: 'Connect your tools',
    body: 'Link GitHub, Jira, and Slack, then connect your calendar. Risezome indexes what your team already knows.',
  },
  {
    n: '02',
    title: 'Flip the bot onto a meeting',
    body: 'On your upcoming calls, toggle the bot on for the ones that matter. It joins your Zoom or Google Meet for you, with nothing for other attendees to install.',
  },
  {
    n: '03',
    title: 'Get cited answers, live',
    body: 'As questions come up, Risezome surfaces a synthesized answer with its sources in the live view. Questions nothing can answer are captured to improve your docs.',
  },
];

export function ValueSections(): React.ReactElement {
  return (
    <>
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <div className="mb-10 text-center">
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Built for the live meeting
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted">
            Not another post-meeting recap. Risezome works while the conversation is still
            happening, grounded in the tools you already use.
          </p>
        </div>
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

      {/* Distinct from the bordered value cards above: a numbered stepper on a
          tinted band reads as a sequential process, not another card grid. */}
      <section id="how-it-works" className="border-y border-border bg-card/30">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          <div className="mb-12 text-center">
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              How it works
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-muted">
              Three steps, then it stays out of your way until it has something worth showing.
            </p>
          </div>
          <ol className="relative grid gap-x-8 gap-y-10 text-center sm:grid-cols-3">
            {/* Connector line behind the centered circles (desktop); the opaque
                circles cover it, leaving the segments between them visible. */}
            <span
              aria-hidden="true"
              className="absolute left-[16.66%] right-[16.66%] top-5 hidden h-px bg-border sm:block"
            />
            {STEPS.map((step) => (
              <li key={step.n} className="relative">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
                  {step.n}
                </div>
                <h3 className="mt-5 text-base font-semibold tracking-tight">{step.title}</h3>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
