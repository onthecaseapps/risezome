import type { ReactElement } from 'react';

/**
 * Risezome rising-chevron logo. Three stacked chevrons with progressively
 * higher opacity (0.32 → 0.6 → 1) — encodes the "rising" motion and
 * pulls the eye to the top chevron. Single color via currentColor so the
 * parent can theme it via Tailwind `text-accent`, `text-fg`, etc.
 *
 * Source SVG from the design reference (logos.jsx); reduced to the three
 * load-bearing paths + minimal markup. The original wrapped each path in
 * hundreds of inline-CSS declarations that have no semantic value.
 */
export function Logo({
  className,
  size = 34,
  title,
}: {
  className?: string;
  size?: number;
  title?: string;
}): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title !== undefined ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title === undefined ? true : undefined}
    >
      <path d="M6 24l10-8 10 8" strokeWidth={2.4} opacity={0.32} />
      <path d="M8 16.5l8-6.4 8 6.4" strokeWidth={2.4} opacity={0.6} />
      <path d="M10.5 9.2L16 5l5.5 4.2" strokeWidth={2.6} />
    </svg>
  );
}
