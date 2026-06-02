'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from './wordmark';

export function SiteHeader(): React.ReactElement {
  // The logo always links home, but off the landing page (e.g. /blog) we
  // also surface an explicit "Home" text link so the way back is obvious.
  const pathname = usePathname();
  const onHome = pathname === '/';

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Risezome home">
          <Wordmark size="lg" />
        </Link>
        {/* Minimal nav: the "Request early access" CTA lives in the hero (and
            blog-post footers), so the header stays uncluttered — just wayfinding
            links that fit comfortably on mobile. */}
        <nav className="flex items-center gap-5 text-sm">
          {!onHome ? (
            <Link href="/" className="font-medium text-muted transition-colors hover:text-fg">
              Home
            </Link>
          ) : null}
          <Link href="/blog" className="font-medium text-muted transition-colors hover:text-fg">
            Blog
          </Link>
        </nav>
      </div>
    </header>
  );
}
