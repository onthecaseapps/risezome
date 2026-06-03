import type { Metadata } from 'next';
import { Schibsted_Grotesk, Space_Grotesk } from 'next/font/google';
import { THEME_INIT_SCRIPT } from '@risezome/hud-ui';
import './globals.css';

const schibstedGrotesk = Schibsted_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-schibsted-grotesk',
});

// Brand display face (the rising-chevron wordmark + demo headlines). Schibsted
// stays the UI/body font; Space Grotesk is reserved for display moments.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  weight: ['500', '700'],
  variable: '--font-space-grotesk',
});

export const metadata: Metadata = {
  title: 'Risezome — answers, before you ask.',
  description:
    'Risezome is a meeting copilot that surfaces relevant context (pull requests, tickets, and docs) the moment it matters. No querying, no searching, no asking.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html
      lang="en"
      className={`${schibstedGrotesk.variable} ${spaceGrotesk.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
