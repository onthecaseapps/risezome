import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environmentMatchGlobs: [['apps/hud/**/*.test.ts', 'happy-dom']],
    environment: 'node',
    include: ['**/test/**/*.test.ts', '**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
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
