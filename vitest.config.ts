import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environmentMatchGlobs: [['apps/hud/**/*.test.ts', 'happy-dom']],
    environment: 'node',
    include: ['**/test/**/*.test.ts', '**/*.test.ts'],
    // apps/web runs its own Vitest (React plugin + jsdom) via apps/web/vitest.config.ts.
    // Excluded here so the root node-env runner doesn't pick up its .test.ts(x) files.
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', 'apps/web/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/test/**',
        '**/*.config.{ts,js,mjs}',
        '**/*.d.ts',
      ],
    },
  },
});
