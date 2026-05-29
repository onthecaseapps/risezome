import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Upwell — meeting context that finds you',
  description:
    'Upwell is a local-first meeting copilot that surfaces relevant context — pull requests, tickets, docs — the moment it matters. No querying, no bot, no asking.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
