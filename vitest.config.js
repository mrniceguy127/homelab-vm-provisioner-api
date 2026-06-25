import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    isolate: true,  // Run each test file in isolation
    sequence: {
      concurrent: false,  // Run tests sequentially
    },
    server: {
      deps: {
        inline: ['amqplib'],  // Include amqplib in the bundle
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: '.build/coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 64,
        statements: 80,
      },
    },
  },
});
