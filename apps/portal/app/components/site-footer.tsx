import { Wordmark } from './wordmark';

export function SiteFooter(): React.ReactElement {
  return (
    <footer className="border-t border-border/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            Early development · Linux
          </span>
        </div>
        <div className="flex items-center gap-6 text-sm text-muted">
          <a
            href="mailto:hello@upwell.dev"
            className="transition-colors hover:text-fg"
          >
            Contact
          </a>
          <span>© {new Date().getFullYear()} Upwell</span>
        </div>
      </div>
    </footer>
  );
}
