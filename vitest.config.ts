import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // hud-next + web each have their own Vitest configs (happy-dom/jsdom for .tsx).
    // The root-level project covers daemon + shared-types only.
    environment: 'node',
    include: ['**/test/**/*.test.ts', '**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/apps/hud-next/**',
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
