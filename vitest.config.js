import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: '.build/coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js'],
    },
  },
});
