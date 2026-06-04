/**
 * Shared UI class recipes for the authed app, so primary actions stay visually
 * identical across pages instead of drifting per-file.
 *
 * The foreground is `text-accent-fg`, NOT a hardcoded `text-white`: accent-fg is
 * the token-correct foreground on the accent fill. In dark mode the accent lifts
 * to a light indigo (#7c83ff) and accent-fg flips to near-black (#0f1115), which
 * keeps the label at AA contrast — plain white there fails (~2.4:1).
 */
export const primaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60';
