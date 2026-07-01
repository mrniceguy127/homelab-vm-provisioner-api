import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Pin DB service host/port so tests are deterministic regardless of any
    // ambient DB_SERVICE_HOST/DB_SERVICE_PORT exported in the shell.
    env: {
      DB_SERVICE_HOST: '172.17.0.1',
      DB_SERVICE_PORT: '3002',
    },
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
