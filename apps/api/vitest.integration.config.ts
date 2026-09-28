import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      EMAIL_PROVIDER: 'console',
      REPORT_INGEST_SECRET: 'test-report-ingest-secret-please-change',
      // A known value so the staff operations can be exercised. The tests that
      // matter assert that a workspace session cannot reach them, which needs
      // the key to exist, otherwise the route is simply closed and the test
      // would pass for the wrong reason.
      STAFF_API_KEY: 'test-staff-key-not-a-real-secret',
    },
  },
});
