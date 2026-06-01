import type { ReactElement } from 'react';
import Link from 'next/link';
import { ChevronBackground } from './_chevron-background';

interface Feature {
  title: string;
  body: string;
  tag?: string;
}

/**
 * Curated, user-facing changelog. Newest first. Keep entries short — this is
 * a "what changed for you" surface, not a commit log.
 */
const FEATURES: Feature[] = [
  {
    title: 'Trello, Jira & Confluence connectors',
    body: 'Connect more of your stack — index Trello cards, Jira issues, and Confluence pages right alongside your GitHub repos.',
    tag: 'New',
  },
  {
    title: 'Choose which branch to index',
    body: 'Point any GitHub repo at a specific branch from Sources → ⋮ → Manage repo settings.',
    tag: 'New',
  },
  {
    title: 'Cited live answers',
    body: 'The live AI summary now cites its sources inline — click a citation to expand the source with the exact quote highlighted.',
  },
  {
    title: 'Smarter reindexing',
    body: 'Reindex only what changed (delta), or do a full rebuild that also prunes anything deleted at the source.',
  },
  {
    title: 'Meetings that close cleanly',
    body: 'Live meetings now wrap up reliably — no more sessions stuck "recording" if the bot drops mid-call.',
  },
];

export default function WhatsNewPage(): ReactElement {
  return (
    <div className="relative min-h-full overflow-hidden">
      <ChevronBackground />

      <div className="relative z-10 min-h-full p-6 sm:p-10">
        <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white/70 p-8 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#0e1018]/70">
          {/* Easter egg: the "Risezome" label opens a blank background-only page. */}
          <Link
            href="/whats-new/background"
            className="text-xs font-medium uppercase tracking-[0.18em] text-[#5b61d6] transition-colors hover:text-[#7c83ff] dark:text-[#7c83ff] dark:hover:text-[#a8acff]"
          >
            Risezome
          </Link>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-[#1a1a1c] dark:text-white">
            What&rsquo;s new
          </h1>
          <p className="mt-1 text-sm text-black/55 dark:text-white/55">
            The latest improvements to your meeting copilot.
          </p>

          <ul className="mt-7 flex flex-col gap-6">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3.5">
                <ChevronBullet />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-medium text-[#1a1a1c] dark:text-white">{f.title}</h2>
                    {f.tag !== undefined ? (
                      <span className="rounded-full bg-[#7c83ff]/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#5b61d6] dark:text-[#a8acff]">
                        {f.tag}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-black/60 dark:text-white/60">{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Small rising-chevron bullet, echoing the background mark. */
function ChevronBullet(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#7c83ff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0"
      aria-hidden="true"
    >
      <path d="M5 14l7-6 7 6" />
    </svg>
  );
}
