import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Upwell: live meeting context',
  description:
    'Upwell is a meeting copilot that surfaces relevant context (pull requests, tickets, and docs) the moment it matters. No querying, no searching, no asking.',
};

// No-flash theme init: apply the .dark class before paint based on the OS
// preference, so the ported HUD tokens render in the right mode on first paint.
// A future toggle can override this (theme switch is deferred - see plan).
const themeInit = `(function(){try{if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark')}}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
