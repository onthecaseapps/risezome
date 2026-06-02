import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { BlogPost, PostBlock } from './_posts';

/**
 * Expand `**bold**` spans in post copy into <strong> elements. Everything
 * outside the markers is plain text (no raw HTML is interpreted), so post
 * content can never inject markup. Unmatched/odd markers degrade to literal
 * text rather than throwing.
 */
export function renderInline(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  // Even indices are plain text, odd indices are the bolded captures.
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-semibold text-fg">{part}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** Long-form date, e.g. "June 2, 2026". Built from the ISO yyyy-mm-dd
 *  parts directly so it's timezone-stable (no Date parsing drift). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${months[m - 1]} ${String(d)}, ${String(y)}`;
}

function Block({ block }: { block: PostBlock }): ReactElement {
  switch (block.kind) {
    case 'heading':
      return (
        <h2
          id={block.id}
          className="mt-12 scroll-mt-24 text-pretty text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {block.text}
        </h2>
      );
    case 'para':
      return <p className="mt-5 text-lg leading-relaxed text-fg/90">{renderInline(block.text)}</p>;
    case 'list':
      return block.ordered === true ? (
        <ol className="mt-5 list-decimal space-y-3 pl-6 text-lg leading-relaxed text-fg/90 marker:text-muted">
          {block.items.map((item, i) => (
            <li key={i} className="pl-1.5">{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className="mt-5 space-y-3 text-lg leading-relaxed text-fg/90">
          {block.items.map((item, i) => (
            <li key={i} className="relative pl-6">
              <span
                aria-hidden="true"
                className="absolute left-0 top-[0.7em] h-1.5 w-1.5 rounded-full bg-accent"
              />
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote className="mt-9 border-l-2 border-accent pl-5 sm:pl-6">
          <p className="text-pretty text-xl font-medium leading-relaxed text-fg sm:text-2xl">
            {renderInline(block.text)}
          </p>
          {block.attribution !== undefined ? (
            <footer className="mt-3 text-sm text-muted">{block.attribution}</footer>
          ) : null}
        </blockquote>
      );
    case 'stats':
      return (
        <div className="mt-9 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
          {block.items.map((s, i) => (
            <div key={i} className="bg-card p-5">
              <div className="text-3xl font-bold tracking-tight text-accent">{s.value}</div>
              <div className="mt-2 text-sm leading-snug text-muted">{s.label}</div>
            </div>
          ))}
        </div>
      );
    case 'callout':
      return (
        <aside className="mt-10 rounded-2xl border border-accent/25 bg-accent-soft/50 p-6 sm:p-7">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-accent">{block.title}</h3>
          </div>
          <p className="mt-3 text-lg leading-relaxed text-fg/90">{renderInline(block.text)}</p>
        </aside>
      );
  }
}

export function PostBody({ post }: { post: BlogPost }): ReactElement {
  return (
    <div>
      {post.body.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

/** Author avatar stand-in: monogram disc, matching the brand accent. */
export function AuthorBadge({ name }: { name: string }): ReactElement {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg"
    >
      {initials}
    </span>
  );
}
