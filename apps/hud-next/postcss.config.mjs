/**
 * Tailwind v4 wires into PostCSS via its dedicated plugin. The CSS-first
 * config lives in app/styles.css via the `@import "tailwindcss"` directive.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
