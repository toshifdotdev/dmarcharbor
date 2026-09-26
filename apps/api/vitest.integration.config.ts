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
    },
  },
});
