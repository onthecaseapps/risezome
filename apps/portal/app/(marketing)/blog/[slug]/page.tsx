import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAllPosts, getPost, tableOfContents } from '../_posts';
import { AuthorBadge, PostBody, formatDate } from '../_components';

interface PageProps {
  // Next.js 15+/16 passes route params as a Promise.
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (post === undefined) return { title: 'Not found | Risezome' };
  const title = `${post.title} | Risezome`;
  return {
    title,
    description: post.excerpt,
    openGraph: {
      title,
      description: post.excerpt,
      type: 'article',
      publishedTime: post.date,
    },
  };
}

export default async function BlogPostPage({ params }: PageProps): Promise<React.ReactElement> {
  const { slug } = await params;
  const post = getPost(slug);
  if (post === undefined) notFound();

  const toc = tableOfContents(post);
  const others = getAllPosts().filter((p) => p.slug !== post.slug);

  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
      <Link
        href="/blog"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-fg"
      >
        <span aria-hidden="true">←</span> Back to blog
      </Link>

      <header className="mt-8 border-b border-border pb-8">
        <p className="text-sm font-medium uppercase tracking-wider text-accent">{post.kicker}</p>
        <h1 className="mt-3 text-balance text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
          {post.title}
        </h1>
        <p className="mt-5 text-pretty text-xl leading-relaxed text-muted">{post.excerpt}</p>

        <div className="mt-7 flex items-center gap-3">
          <AuthorBadge name={post.author} />
          <div className="text-sm">
            <div className="font-medium text-fg">{post.author}</div>
            <div className="text-muted">
              {formatDate(post.date)} · {post.readingMinutes} min read
            </div>
          </div>
        </div>
      </header>

      {toc.length > 1 ? (
        <nav aria-label="Table of contents" className="mt-8 rounded-2xl border border-border bg-card/50 p-5 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">In this post</p>
          <ol className="mt-3 space-y-2 text-sm">
            {toc.map((h, i) => (
              <li key={h.id} className="flex gap-3">
                <span className="tabular-nums text-muted">{String(i + 1).padStart(2, '0')}</span>
                <a href={`#${h.id}`} className="text-fg/80 transition-colors hover:text-accent">
                  {h.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="mt-4">
        <PostBody post={post} />
      </div>

      <div className="mt-16 border-t border-border pt-10">
        <div className="rounded-2xl border border-accent/25 bg-accent-soft/40 p-7 text-center sm:p-9">
          <h2 className="text-pretty text-2xl font-semibold tracking-tight">
            See answers surface while the meeting is still happening
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-pretty text-lg text-muted">
            Risezome listens, retrieves, and shows your team the context that matters, live, cited,
            in the room. No querying. No searching. No asking.
          </p>
          <Link
            href="/#waitlist"
            className="mt-6 inline-flex rounded-xl bg-accent px-6 py-3 font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90"
          >
            Request early access
          </Link>
        </div>
      </div>

      {others.length > 0 ? (
        <aside className="mt-14">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Keep reading</h2>
          <ul className="mt-4 space-y-4">
            {others.map((p) => (
              <li key={p.slug}>
                <Link
                  href={`/blog/${p.slug}`}
                  className="group flex flex-col gap-1 rounded-xl border border-border bg-card p-5 transition-colors hover:border-accent/40"
                >
                  <span className="text-xs font-medium text-accent">{p.kicker}</span>
                  <span className="text-pretty text-lg font-semibold tracking-tight group-hover:text-accent">
                    {p.title}
                  </span>
                  <span className="text-pretty text-sm leading-relaxed text-muted">{p.excerpt}</span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </article>
  );
}
