import { Hero } from '../components/hero';
import { ValueSections } from '../components/value-sections';
import { WaitlistForm } from '../components/waitlist-form';
import { MeetingDemo } from '../components/demo/meeting-demo';

export default function Home(): React.ReactElement {
  return (
    <>
      {/* Split hero: copy + CTAs on the left, the live demo on the right so
          visitors see Risezome working the moment they land. Stacks to a
          single column on mobile (copy first, demo below). */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-32 h-96 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_srgb,var(--accent)_18%,transparent),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 sm:px-8 sm:pb-24 sm:pt-24">
          <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-12">
            <Hero />
            <div id="demo">
              <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-sm sm:p-5">
                <MeetingDemo />
              </div>
            </div>
          </div>
        </div>
      </section>

      <ValueSections />

      <WaitlistForm />
    </>
  );
}
