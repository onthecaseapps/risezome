import './styles.css';
import type { ReactElement, ReactNode } from 'react';

export const metadata = {
  title: 'Upwell',
};

// `suppressHydrationWarning` on <html> is required because U3's theme inline
// script mutates `documentElement.classList` before React hydrates — that
// produces a benign hydration mismatch that this attribute silences.
export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
