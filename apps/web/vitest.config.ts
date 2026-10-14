import { defineConfig } from "vitest/config";

/**
 * Unit tests for the browser-side logic that has no DOM requirement.
 *
 * The web workspace shipped no tests at all, which is why the error-handling
 * defect below survived: every failing request answered "The request could not
 * be sent." and nothing asserted otherwise. `lib/ui-errors.ts` exists to fix
 * exactly that, and a fix with no test is a fix that can be undone.
 *
 * `environment` is left as Node rather than jsdom deliberately. These modules
 * are pure logic over strings and `Response`, both of which are global in Node
 * 18+, and adding a DOM environment to test a message formatter would slow the
 * run to cover nothing. A component test would need `jsdom` and a separate
 * config; it is not this file's job.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["**/node_modules/**", ".next/**"],
    // Tests are independent and fast, so they run in parallel. Unlike the API's
    // suite there is no shared database to serialise around.
    fileParallelism: true,
  },
});
