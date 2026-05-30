import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,
    setupFiles: [],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
