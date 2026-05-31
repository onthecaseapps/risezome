import type { Metadata } from 'next';
import { Schibsted_Grotesk } from 'next/font/google';
import './globals.css';

const schibstedGrotesk = Schibsted_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-schibsted-grotesk',
});

export const metadata: Metadata = {
  title: 'Risezome — answers, before you ask.',
  description:
    'Risezome is a meeting copilot that surfaces relevant context (pull requests, tickets, and docs) the moment it matters. No querying, no searching, no asking.',
};

// No-flash theme init: apply the .dark class before paint based on the OS
// preference. A future toggle can override this.
const themeInit = `(function(){try{if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark')}}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en" className={schibstedGrotesk.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
