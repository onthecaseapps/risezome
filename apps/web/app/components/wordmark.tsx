/**
 * Upwell wordmark - a small upward-swelling glyph (the "well" rising) plus the
 * name. Uses the accent token so it tracks the theme. Kept as inline SVG to
 * avoid an asset request and to inherit currentColor.
 */
export function Wordmark(): React.ReactElement {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight text-fg">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="text-accent"
      >
        <path
          d="M3 17c3.5 0 4.5-10 9-10s5.5 10 9 10"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="12" cy="7" r="1.8" fill="currentColor" />
      </svg>
      <span className="text-[17px]">Upwell</span>
    </span>
  );
}
