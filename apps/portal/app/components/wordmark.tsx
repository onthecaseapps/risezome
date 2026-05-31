import { Logo } from '../_components/logo';

/**
 * Risezome wordmark: the shared rising-chevron Logo plus the name. Reuses the
 * same Logo component as the app sidebar so the brand mark stays identical
 * across marketing and product. Accent-themed so it tracks light/dark.
 *
 * `size` scales both the logo and the name together: `md` for the footer,
 * `lg` for the marketing header where the brand should read bigger.
 */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }): React.ReactElement {
  const lg = size === 'lg';
  return (
    <span className="flex items-center gap-2.5 font-semibold tracking-tight text-fg">
      <Logo size={lg ? 32 : 24} className="text-accent" />
      <span className={lg ? 'text-2xl' : 'text-[17px]'}>Risezome</span>
    </span>
  );
}
