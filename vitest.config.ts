import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // hud-next has its own vitest.config.ts (happy-dom, .tsx support).
    // The root-level project covers the daemon and shared-types only.
    environment: 'node',
    include: ['**/test/**/*.test.ts', '**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/apps/hud-next/**'],
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
