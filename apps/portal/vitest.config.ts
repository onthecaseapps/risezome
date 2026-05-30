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
  },
});
