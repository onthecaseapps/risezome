import './styles.css';
import type { ReactElement, ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from './lib/theme';

export const metadata = {
  title: 'Upwell',
};

// `suppressHydrationWarning` on <html> is required because the theme inline
// script mutates `documentElement.classList` before React hydrates — that
// produces a benign hydration mismatch that this attribute silences.
//
// The inline script's SHA-256 hash is added to the daemon's CSP allow-list
// in U5. The script string itself is static across builds (see lib/theme.ts).
export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
