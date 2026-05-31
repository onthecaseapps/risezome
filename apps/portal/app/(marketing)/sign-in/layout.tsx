import type { ReactElement, ReactNode } from 'react';

/**
 * Sign-in route override layout. The parent (marketing)/layout.tsx wraps
 * children in <SiteHeader /> + <SiteFooter /> (landing-page chrome with
 * the marketing nav). That chrome doesn't belong on /sign-in — sign-in
 * users are already past marketing, and the duplicated wordmark + nav
 * was visually confusing.
 *
 * This layout renders {children} unwrapped so the sign-in page owns its
 * full-viewport split-screen layout without competing chrome.
 */
export default function SignInLayout({ children }: { children: ReactNode }): ReactElement {
  return <>{children}</>;
}
