import { SiteHeader } from '../components/site-header';
import { SiteFooter } from '../components/site-footer';

/**
 * Marketing chrome. Public pages render inside this layout; a future
 * authenticated portal lives under a sibling app/(app)/ route group with its
 * own chrome, so the two never share navigation (landing-page plan, U2).
 */
export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
