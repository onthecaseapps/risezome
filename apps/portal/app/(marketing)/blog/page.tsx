import type { Metadata } from 'next';
import Link from 'next/link';
import { getAllPosts } from './_posts';
import { formatDate } from './_components';

export const metadata: Metadata = {
  title: 'Blog | Risezome',
  description:
    'Notes on meetings, knowledge, and surfacing answers the moment they matter, from the team building Risezome.',
  openGraph: {
    title: 'Blog | Risezome',
    description:
      'Notes on meetings, knowledge, and surfacing answers the moment they matter, from the team building Risezome.',
    type: 'website',
  },
};

export default function BlogIndex(): React.ReactElement {
  const posts = getAllPosts();
  const [lead, ...rest] = posts;

  return (
    <div className="mx-auto max-w-3xl px-5 pb-24 pt-16 sm:px-8 sm:pt-20">
      <header className="border-b border-border pb-8">
        <p className="text-sm font-medium uppercase tracking-wider text-accent">Blog</p>
        <h1 className="mt-3 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          On meetings &amp; knowledge
        </h1>
        <p className="mt-4 max-w-2xl text-pretty text-lg text-muted">
          Short essays on why timing changes everything in a meeting, and how the questions
          people ask are the clearest map of what your team doesn’t yet know.
        </p>
      </header>

      <ul className="mt-10 space-y-10">
        {lead !== undefined ? (
          <li>
            <Link href={`/blog/${lead.slug}`} className="group block">
              <article className="rounded-2xl border border-border bg-card p-7 shadow-sm transition-colors hover:border-accent/40 sm:p-9">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent">
                    {lead.kicker}
                  </span>
                  <span className="text-muted">
                    {formatDate(lead.date)} · {lead.readingMinutes} min read
                  </span>
                </div>
                <h2 className="mt-4 text-pretty text-2xl font-semibold tracking-tight sm:text-3xl">
                  <span className="bg-gradient-to-r from-accent to-accent bg-[length:0%_2px] bg-left-bottom bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_2px]">
                    {lead.title}
                  </span>
                </h2>
                <p className="mt-3 text-pretty text-lg leading-relaxed text-muted">{lead.excerpt}</p>
                <span className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  Read the post
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
                </span>
              </article>
            </Link>
          </li>
        ) : null}

        {rest.map((post) => (
          <li key={post.slug}>
            <Link href={`/blog/${post.slug}`} className="group block">
              <article className="border-b border-border pb-10">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent">
                    {post.kicker}
                  </span>
                  <span className="text-muted">
                    {formatDate(post.date)} · {post.readingMinutes} min read
                  </span>
                </div>
                <h2 className="mt-4 text-pretty text-2xl font-semibold tracking-tight">
                  <span className="bg-gradient-to-r from-accent to-accent bg-[length:0%_2px] bg-left-bottom bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_2px]">
                    {post.title}
                  </span>
                </h2>
                <p className="mt-3 text-pretty text-lg leading-relaxed text-muted">{post.excerpt}</p>
              </article>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
