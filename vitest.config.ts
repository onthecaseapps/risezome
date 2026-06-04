import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // apps/portal owns its own Vitest config (jsdom for .tsx). The root-level
    // project covers bot-worker, engine, and the other Node packages.
    environment: 'node',
    include: ['**/test/**/*.test.ts', '**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/apps/portal/**',
    ],
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
