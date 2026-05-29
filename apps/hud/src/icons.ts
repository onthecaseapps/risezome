// Inline-SVG icon helper. Each Font Awesome icon is shipped as a tiny
// JS object: `icon: [width, height, ligatures, unicode, svgPathData]`.
// We render the path into an <svg> at runtime so we don't pull the
// webfont (no extra HTTP request, no font-src CSP allowance needed,
// crisp at any size). Tree-shaking trims to ~1 KB per icon used.
//
// Per-icon imports (deep paths) keep the bundle small — importing from
// `@fortawesome/free-solid-svg-icons` directly would pull every icon.

import { faSun } from '@fortawesome/free-solid-svg-icons/faSun';
import { faMoon } from '@fortawesome/free-solid-svg-icons/faMoon';
import { faThumbtack } from '@fortawesome/free-solid-svg-icons/faThumbtack';
import { faBookmark } from '@fortawesome/free-solid-svg-icons/faBookmark';
import { faXmark } from '@fortawesome/free-solid-svg-icons/faXmark';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare';

export type IconDef = typeof faSun;

// Explicit type prevents TS from inlining the internal FA common-types
// path into the inferred shape, which would break workspace consumers.
const Icons: Readonly<Record<string, IconDef>> = {
  sun: faSun,
  moon: faMoon,
  thumbtack: faThumbtack,
  bookmark: faBookmark,
  xmark: faXmark,
  externalLink: faArrowUpRightFromSquare,
};

export type IconName = 'sun' | 'moon' | 'thumbtack' | 'bookmark' | 'xmark' | 'externalLink';

export function getIconDef(name: IconName): IconDef {
  return Icons[name]!;
}

/**
 * Build a <span> wrapping an inline <svg> for the named icon. The wrapper
 * inherits color via `currentColor` so a single CSS `color: …` cascades
 * onto the icon paint. Size defaults to 1em so the icon scales with the
 * containing font-size — override via the `size` parameter for fixed-size
 * placements.
 */
export function renderIcon(
  doc: Document,
  name: IconName,
  options: { ariaLabel?: string; size?: string; className?: string } = {},
): HTMLElement {
  const def = getIconDef(name);
  const [width, height, , , path] = def.icon;
  const wrap = doc.createElement('span');
  wrap.className = `icon ${options.className ?? ''}`.trim();
  if (typeof options.ariaLabel === 'string') {
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', options.ariaLabel);
  } else {
    wrap.setAttribute('aria-hidden', 'true');
  }
  const size = options.size ?? '1em';
  const pathData = Array.isArray(path) ? path.join(' ') : path;
  // Use innerHTML for the SVG body — it's static text, not user-controlled.
  // innerHTML keeps the namespace correct (createElement('svg') in the HTML
  // namespace produces a non-rendering element).
  wrap.innerHTML = `<svg viewBox="0 0 ${String(width)} ${String(height)}" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${pathData}"/></svg>`;
  return wrap;
}
