/**
 * Blog content store.
 *
 * The portal has no MDX/CMS pipeline, and adding one (contentlayer,
 * next-mdx-remote, a markdown runtime) is more surface than two launch
 * posts justify. Instead each post is typed structured data: a list of
 * `PostBlock`s the renderer maps to brand-styled elements. This keeps the
 * design fully under our control (same tokens as the landing page), stays
 * dependency-free, and is trivially type-checked + unit-tested.
 *
 * Inline emphasis: paragraph / list / quote text supports `**bold**`
 * spans, expanded by `renderInline` in `_components.tsx`. No raw HTML is
 * ever injected, so the content can't smuggle markup.
 *
 * House style: no em-dashes or en-dashes anywhere in post copy. Use
 * commas, colons, periods, or parentheses instead.
 */

export type PostBlock =
  | { readonly kind: 'heading'; readonly id: string; readonly text: string }
  | { readonly kind: 'para'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered?: boolean; readonly items: readonly string[] }
  | { readonly kind: 'quote'; readonly text: string; readonly attribution?: string }
  | { readonly kind: 'stats'; readonly items: readonly { readonly value: string; readonly label: string }[] }
  | { readonly kind: 'callout'; readonly title: string; readonly text: string };

export interface BlogPost {
  readonly slug: string;
  /** Page <h1> + listing title. */
  readonly title: string;
  /** Listing card copy + meta description + OG description. */
  readonly excerpt: string;
  /** Small category label above the title. */
  readonly kicker: string;
  /** ISO date (yyyy-mm-dd); rendered long-form. */
  readonly date: string;
  readonly readingMinutes: number;
  readonly author: string;
  readonly authorRole: string;
  readonly body: readonly PostBlock[];
}

/**
 * Heading blocks double as the table-of-contents source; `id` is the
 * anchor target. Keep ids unique within a post.
 */
export const POSTS: readonly BlogPost[] = [
  {
    slug: 'answers-during-the-call-not-after',
    title: 'Answers during the call, not after it',
    excerpt:
      'The distance between "I\'ll find out and get back to you" and an answer on screen mid-sentence is where meetings lose their momentum, and where context everyone shared quietly fractures into threads only two people can see.',
    kicker: 'Meeting design',
    date: '2026-06-02',
    readingMinutes: 6,
    author: 'The Risezome Team',
    authorRole: 'Risezome',
    body: [
      {
        kind: 'para',
        text: `Watch any working meeting closely and you'll notice it doesn't end when people stop talking. It ends, and then it keeps going: a flurry of "let me check and circle back," a Slack thread between two of the eight people who were in the room, a follow-up call to re-litigate the decision that was *almost* made. The meeting was the easy part. The expensive part is everything that happens because the room couldn't get an answer while it still had everyone's attention.`,
      },
      {
        kind: 'para',
        text: `That gap, between a question being asked and the answer arriving, is small in clock time and enormous in cost. Closing it during the call, instead of after, changes the economics of the meeting itself. Here's why timing is the whole game.`,
      },

      { kind: 'heading', id: 'four-words', text: 'The most expensive four words in a meeting' },
      {
        kind: 'para',
        text: `"I'll get back to you." It sounds responsible. It is, in practice, the moment a meeting starts leaking value. The question that prompted it was *live*: the right people were in the room, the context was loaded, the decision was one fact away from being made. Defer the answer and all of that has to be rebuilt later, usually by fewer people, often by the wrong ones.`,
      },
      {
        kind: 'para',
        text: `Every deferral is a promise to do three things later: find the answer, find the people, and rebuild the context. Most teams only ever do the first.`,
      },

      { kind: 'heading', id: 'flow', text: 'Flow is fragile, and digging breaks it' },
      {
        kind: 'para',
        text: `The alternative to deferring is worse: someone alt-tabs to go find the answer mid-meeting. Now seven people watch one person scroll through GitHub while the thread of conversation goes cold. The momentum a good meeting builds (the shared line of reasoning everyone is holding in their head) doesn't pause politely. It evaporates.`,
      },
      {
        kind: 'para',
        text: `Attention researchers have a number for how long it takes to fully re-engage with a task after an interruption: it's measured in the tens of minutes, not seconds. A meeting can't afford that, so people don't actually dig. They defer, which puts you right back at the four most expensive words.`,
      },
      {
        kind: 'stats',
        items: [
          { value: '~23 min', label: 'Time attention research finds it takes to fully refocus after a context switch' },
          { value: '8 to 2', label: 'People who heard the question vs. people who see the answer when it lands in a DM later' },
          { value: '0', label: 'Follow-up threads needed when the answer is already on screen' },
        ],
      },
      {
        kind: 'para',
        text: `Surfacing the answer *in the meeting* (retrieved automatically, cited, on a shared screen) means nobody has to choose between breaking flow and losing the thread. The answer arrives without anyone leaving the conversation.`,
      },

      { kind: 'heading', id: 'side-channel', text: 'The side-channel problem' },
      {
        kind: 'para',
        text: `Here's the failure mode that quietly does the most damage. A question goes unanswered in the room. Afterward, two people who happened to know each other take it to a DM. They sort it out. The answer is good. And it reaches exactly two of the eight people who needed it.`,
      },
      {
        kind: 'para',
        text: `The other six were in the room *specifically* so they'd share the context. Instead, the resolution happened in a private channel they'll never see. The next time the topic comes up, they're working from the pre-answer version of reality, and the meeting that was supposed to align everyone has, in the part that mattered most, aligned no one.`,
      },
      {
        kind: 'quote',
        text: `An answer delivered after the meeting reaches whoever happened to be in the thread. An answer delivered during the meeting reaches everyone who was in the room. That's not a small difference. It's the entire point of meeting together.`,
      },
      {
        kind: 'para',
        text: `When the answer surfaces live, it's a shared artifact. Everyone hears it, sees the source it came from, and can react to it together: challenge it, build on it, decide on it. Context stays common. It never gets privatized into a thread.`,
      },

      { kind: 'heading', id: 'what-during-changes', text: 'What "during" actually changes' },
      {
        kind: 'para',
        text: `Moving the answer from after to during isn't a marginal convenience. It changes what the meeting is capable of producing:`,
      },
      {
        kind: 'list',
        items: [
          `**Decisions get made once.** With the fact in the room, the group decides while it's assembled, instead of deferring and then reconvening to decide the same thing with worse recall.`,
          `**Context stays shared.** The answer is heard by everyone, not relayed to a few. No one is quietly left on the old version of the story.`,
          `**Follow-up shrinks.** Fewer "as discussed, here's what I found" messages, fewer status pings, fewer meetings about the last meeting.`,
          `**The answer is grounded and visible.** It comes with its source attached, in front of the whole group, so it can be trusted or questioned on the spot, not taken on faith from a summary later.`,
          `**Momentum survives.** Nobody breaks flow to go hunting, so the conversation keeps its thread and its energy.`,
        ],
      },

      { kind: 'heading', id: 'compounding-cost', text: 'The compounding cost of "after"' },
      {
        kind: 'para',
        text: `The case for "during" gets stronger the more you zoom out. A single deferred question is a minor tax. But teams run hundreds of meetings a month, and every deferral spawns the same downstream work: the search, the side-channel, the partial broadcast, the re-alignment, sometimes a whole follow-up meeting. Multiply that and "I'll get back to you" stops being a courtesy and starts being a structural drag on how fast the organization can actually move.`,
      },
      {
        kind: 'para',
        text: `Close the gap and the whole pattern collapses. The answer arrives while everyone is present, gets absorbed by the group, and never has to be rebuilt. The meeting does what it was for, and then it's actually over.`,
      },
      {
        kind: 'callout',
        title: 'This is the bet Risezome is built on',
        text: `Risezome listens to your meeting and surfaces the pull requests, tickets, and docs that answer the question being asked, right when it's asked, on a shared live page, with the source cited. No querying, no digging, no "I'll get back to you." The answer reaches the whole room while the room is still there to use it.`,
      },
    ],
  },

  {
    slug: 'every-question-is-a-map-of-your-knowledge-gaps',
    title: "Every question in a meeting is a map of what your docs don't say",
    excerpt:
      'A question asked out loud is the most honest usage signal your documentation will ever get. Capture those questions, backfill the gaps they expose, and the same questions stop coming back: knowledge work that compounds instead of repeats.',
    kicker: 'Knowledge ops',
    date: '2026-06-02',
    readingMinutes: 6,
    author: 'The Risezome Team',
    authorRole: 'Risezome',
    body: [
      {
        kind: 'para',
        text: `Most teams treat the questions people ask in meetings as friction: interruptions to get through so the agenda can continue. They're actually the most valuable data your organization produces and almost never keeps. Every question asked out loud is a precise, timestamped signal that a piece of knowledge wasn't reachable when someone needed it. That's not noise. That's a map.`,
      },

      { kind: 'heading', id: 'a-question-is-a-gap', text: 'A question is a gap with a location' },
      {
        kind: 'para',
        text: `When someone asks "wait, did that ticket ever get merged?" or "what did we decide about the rate limits?", they're not just looking for an answer. They're reporting a failure: the answer existed somewhere, but it wasn't where they could get to it, in the form they needed, at the moment they needed it. The question is the gap, made audible.`,
      },
      {
        kind: 'quote',
        text: `A question asked out loud is the only honest usage analytics your documentation will ever get. It tells you exactly what people needed and couldn't find, not what you guessed they'd want when you wrote the docs.`,
      },
      {
        kind: 'para',
        text: `This is why questions are better signal than almost anything else. Documentation written from imagination describes the system as its authors understand it. Documentation written from real questions describes the system as people actually struggle with it. Only one of those gets used.`,
      },

      { kind: 'heading', id: 'same-question-twice', text: 'The same question, asked forever' },
      {
        kind: 'para',
        text: `Here's what happens when the gap isn't captured: the question gets answered once, in the room, for the people present, and then it comes back. Next week, a different person. Next month, a new hire. Next quarter, an adjacent team that never even knew the first conversation happened. The same gap generates the same question, over and over, and each time it costs an interruption, an answer, and a little erosion of everyone's patience.`,
      },
      {
        kind: 'para',
        text: `Nobody decides to run their organization this way. It happens because the gap is invisible. The question evaporates the moment it's answered, so there's nothing to act on: no record that this is the fifth time, no trigger to write it down once and be done.`,
      },
      {
        kind: 'stats',
        items: [
          { value: '1 question', label: 'is one measured, located gap in your knowledge base' },
          { value: '1 doc', label: 'backfilled from that gap removes every future instance of the question' },
          { value: 'N to 0', label: 'the trajectory of a question once the gap behind it is closed' },
        ],
      },

      { kind: 'heading', id: 'demand-driven-docs', text: 'Demand-driven documentation' },
      {
        kind: 'para',
        text: `Flip the loop around and something powerful happens. Instead of guessing what to document, you let the questions tell you. Capture the questions that get asked, notice which ones recur or land on a thin spot in the knowledge base, and backfill *those* first. You end up writing the documentation people are actively reaching for, not the documentation you imagined they might want.`,
      },
      {
        kind: 'para',
        text: `It's the difference between writing docs speculatively and writing them against real demand:`,
      },
      {
        kind: 'list',
        items: [
          `**You document what's actually missing**, not what's easy or obvious to write.`,
          `**You prioritize by frequency.** A question asked five times this month outranks the page someone *thought* would be useful.`,
          `**Coverage tracks reality.** As the product and the team change, the questions change, and the gaps they expose keep your knowledge base pointed at what matters now.`,
          `**Onboarding compounds.** Each backfilled gap is one more thing the next hire can self-serve instead of interrupting someone to learn.`,
        ],
      },

      { kind: 'heading', id: 'compounding', text: 'Why this compounds' },
      {
        kind: 'para',
        text: `Answering a question is linear work: one question, one answer, gone. Closing the gap behind it is compounding work: one answer that prevents the question from ever needing to be asked again. Do that consistently and the total volume of questions doesn't hold steady. It trends *down*. The knowledge base gets denser exactly where reality is densest, and the cost of finding things falls for everyone, every time.`,
      },
      {
        kind: 'para',
        text: `A team that captures and backfills gets quieter over time in the best possible way. The recurring questions thin out. People find answers themselves. The meetings that used to stall on "does anyone remember..." stop stalling, because the answer is now written down where it can be found, put there by the very question that proved it was missing.`,
      },
      {
        kind: 'quote',
        text: `Answering a question helps the people in the room. Closing the gap behind it helps everyone who would have asked it next. The first is support. The second is leverage.`,
      },

      { kind: 'heading', id: 'closing-the-loop', text: 'Closing the loop automatically' },
      {
        kind: 'para',
        text: `The reason this loop is rare isn't that teams don't believe in it. It's that capturing every question, noticing which expose real gaps, and routing them back into the docs is tedious manual work nobody owns. So it doesn't happen, and the same questions keep coming.`,
      },
      {
        kind: 'para',
        text: `That's exactly the kind of bookkeeping software should do. If something is already listening to the meeting to surface answers, it's in the perfect position to do the other half too: notice the questions that landed on thin or missing knowledge, and turn them into a backlog of gaps worth closing, ranked by how often they actually come up.`,
      },
      {
        kind: 'callout',
        title: 'How Risezome closes the loop',
        text: `Risezome surfaces answers live during your meetings, and in doing so it sees exactly which questions your connected sources couldn't answer well. Those become a map of your real knowledge gaps, demand-ranked, ready to backfill. Answer the room now; make the next room's questions disappear.`,
      },
    ],
  },
];

export function getAllPosts(): readonly BlogPost[] {
  // Newest first. Dates are ISO yyyy-mm-dd so a string compare is a date
  // compare; ties keep source order (stable sort).
  return [...POSTS].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

/** Heading blocks, in document order, for the table of contents. */
export function tableOfContents(post: BlogPost): readonly { id: string; text: string }[] {
  return post.body.filter((b): b is Extract<PostBlock, { kind: 'heading' }> => b.kind === 'heading');
}
