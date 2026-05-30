import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
