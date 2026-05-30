/**
 * Tailwind v4 wires into PostCSS via its dedicated plugin (matching the
 * @risezome/hud build, which runs the standalone CLI instead). The CSS-first
 * config lives in app/globals.css via the `@import "tailwindcss"` directive.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
