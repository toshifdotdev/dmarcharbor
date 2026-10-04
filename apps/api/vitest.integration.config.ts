import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    fileParallelism: false,
    // Raised from 20s. Every file truncates the same set of tables in beforeAll,
    // and TRUNCATE ... CASCADE over that set is measured in seconds, not
    // milliseconds. On a busy machine it crosses 20s and the whole file is
    // reported as skipped, which looks like a product failure and is not one.
    // This was flagged in the launch checklist as spurious failures under load
    // and has now produced them twice.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      EMAIL_PROVIDER: 'console',
      REPORT_INGEST_SECRET: 'test-report-ingest-secret-please-change',
      // A known value so the staff operations can be exercised. The tests that
      // matter assert that a workspace session cannot reach them, which needs
      // the key to exist, otherwise the route is simply closed and the test
      // would pass for the wrong reason.
      STAFF_API_KEY: 'test-staff-key-not-a-real-secret',
      // The auth rate limiter is real and mounted, not stubbed out, so the suite
      // genuinely exercises it on every sign-in. The budget is raised because
      // every file authenticates repeatedly from 127.0.0.1 and would otherwise
      // trip a limit that has nothing to do with what each test asserts.
      // rate-limit.test.ts covers the limit itself engaging.
      AUTH_RATE_LIMIT_PER_MINUTE: '10000',
      API_RATE_LIMIT_PER_MINUTE: '100000',
    },
  },
});
