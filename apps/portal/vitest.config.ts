import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * apps/portal runs its own Vitest with the React plugin + jsdom so component
 * tests (.tsx) and reducer tests run together. The repo-root vitest.config.ts
 * excludes apps/portal (it only matches .test.ts in node env and has no React
 * plugin), keeping this app's test toolchain self-contained.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    server: {
      deps: {
        // The AWS Encryption SDK (@aws-crypto) and the shared crypto module that
        // wraps it must be loaded by real Node as a SINGLE compiled instance —
        // NOT transformed/inlined by Vite's SSR pipeline, which duplicates the
        // @aws-crypto material-management package and breaks the data-key
        // type-brand check ("Unsupported dataKey type"). Tests that exercise
        // crypto declare `// @vitest-environment node` so they run outside jsdom.
        external: [/@risezome\/crypto/, /@aws-crypto\//],
      },
    },
  },
});
