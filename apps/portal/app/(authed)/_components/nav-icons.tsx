import type { ReactElement } from 'react';

const baseProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Calendar — for the Upcoming meetings nav item. */
export function CalendarIcon(): ReactElement {
  return (
    <svg {...baseProps}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

/** Concentric radio waves — for the Live meeting nav item. */
export function LiveIcon(): ReactElement {
  return (
    <svg {...baseProps}>
      <path d="M5 16a9 9 0 0 1 14 0" />
      <path d="M8 13a5 5 0 0 1 8 0" />
      <circle cx="12" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

/** Database / stacked discs — for the Sources nav item. */
export function SourcesIcon(): ReactElement {
  return (
    <svg {...baseProps}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

/** Hanging lines — for the Captures nav item. */
export function CapturesIcon(): ReactElement {
  return (
    <svg {...baseProps}>
      <path d="M4 6h16M4 12h10M4 18h16" />
    </svg>
  );
}
