import type { ReactElement } from 'react';
import type { KnownType } from '../types';

/**
 * Minimal inline glyphs for the source-type label, standing in for the HUD's
 * FontAwesome icons (circleDot / codePullRequest / code / fileLines) without
 * pulling the icon dependency.
 *
 * **Modified from the demo:** the demo's TypeGlyph used `aria-hidden={true}`
 * with the adjacent text label carrying the accessible name. The polish-plan
 * U3 explicitly requires `role="img"` + `aria-label` on the glyph wrapper —
 * `title` on a non-interactive span is unreliable across screen readers.
 * U2 of the Next.js conversion plan honors this contract.
 */
export function TypeGlyph({ type, label }: { type: KnownType; label: string }): ReactElement {
  const common = {
    width: 11,
    height: 11,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    role: 'img',
    'aria-label': label,
  };
  switch (type) {
    case 'pull-request':
      return (
        <svg {...common}>
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="4" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <path d="M4 5.6v6M12 10.4V8a2 2 0 0 0-2-2H7" />
        </svg>
      );
    case 'issue':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'code':
      return (
        <svg {...common}>
          <path d="M5.5 5.5 3 8l2.5 2.5M10.5 5.5 13 8l-2.5 2.5" />
        </svg>
      );
    case 'card':
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M5 6h6M5 8.5h4" />
        </svg>
      );
    case 'doc':
    default:
      return (
        <svg {...common}>
          <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z" />
          <path d="M9 2v4h4M5.5 9h5M5.5 11h3" />
        </svg>
      );
  }
}

/** Thumbtack glyph for the Pin action. */
export function PinGlyph(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2 14 6.5l-2.5 1-2 2L9 13l-1.5-1.5M9.5 2 6 3l-2 2 .5 2.5L3 9l4 4" />
    </svg>
  );
}
