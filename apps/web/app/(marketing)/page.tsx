import { MeetingDemo } from '../components/demo/meeting-demo';

export default function Home(): React.ReactElement {
  return (
    <>
      {/* Hero (U3) and value sections (U4) compose here. */}
      <section id="demo" className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
        <div className="mb-8 text-center">
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Watch it work
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted">
            A standup, playing out live. Someone asks a question — Upwell surfaces the pull request,
            the ticket, and the doc, then answers with citations. No one typed a search.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-sm sm:p-6">
          <MeetingDemo />
        </div>
      </section>
      {/* Waitlist (U7) composes here. */}
    </>
  );
}
