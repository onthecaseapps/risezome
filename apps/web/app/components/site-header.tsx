import Link from 'next/link';
import { Wordmark } from './wordmark';

export function SiteHeader(): React.ReactElement {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Upwell home">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <a
            href="#how-it-works"
            className="hidden text-muted transition-colors hover:text-fg sm:inline"
          >
            How it works
          </a>
          <a
            href="#demo"
            className="hidden text-muted transition-colors hover:text-fg sm:inline"
          >
            See it live
          </a>
          <a
            href="#waitlist"
            className="rounded-lg bg-accent px-3.5 py-2 font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90"
          >
            Request early access
          </a>
        </nav>
      </div>
    </header>
  );
}
