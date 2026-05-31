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

/** Gear — for the Settings nav item. */
export function SettingsIcon(): ReactElement {
  return (
    <svg {...baseProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.16.66.42.88.74.22.32.34.7.34 1.09v.34a1.65 1.65 0 0 0 1 1.51H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

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

/** Bug-shaped glyph for the dev-only Debug nav section. */
export function DebugIcon(): ReactElement {
  return (
    <svg {...baseProps}>
      <rect x="8" y="6" width="8" height="12" rx="4" />
      <path d="M12 6V4M9 4l-2-2M15 4l2-2" />
      <path d="M8 12H4M16 12h4M8 16l-3 3M16 16l3 3M8 8l-3-3M16 8l3-3" />
    </svg>
  );
}
