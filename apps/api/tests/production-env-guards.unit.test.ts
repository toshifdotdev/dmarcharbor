/**
 * Proves the production guards run when NODE_ENV is absent.
 *
 * This is the whole point of the fix. `NODE_ENV` defaulted to `development` and
 * every guard was nested inside `if (NODE_ENV === 'production')`, so a deploy
 * that forgot the variable booted green with BETTER_AUTH_SECRET resolving to a
 * literal committed in the repo. The child process deliberately runs with
 * NODE_ENV removed rather than set, which is the exact failure mode.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const MODES = [
  { label: 'NODE_ENV absent entirely', env: undefined },
  { label: 'NODE_ENV set to something unrecognised', env: 'staging' },
] as const;

describe('production guards run without an explicit NODE_ENV', () => {
  for (const mode of MODES) {
    it(`refuses to boot with ${mode.label}`, () => {
      // Inherit the parent's environment so PATH and DATABASE_URL resolve, then
      // remove the one variable under test.
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key !== 'NODE_ENV' && value !== undefined) env[key] = value;
      }
      if (mode.env !== undefined) env.NODE_ENV = mode.env;

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--eval', "import('./src/config/env.js')"],
        { encoding: 'utf8', env, cwd: process.cwd() },
      );

      // Not 0. A boot that starts is the defect, so the assertion is on the exit
      // code rather than on the message being any particular string.
      expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).not.toBe(0);

      // And it says which guard refused, not a generic crash. Matching the
      // message prefixes rather than the word "production" alone, so an
      // unrelated crash that happens to mention it still fails this test.
      const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(combined).toMatch(
        /(must be set in production|Production requires|must be set explicitly in production|must be an https URL in production)/,
      );
    });
  }

  it('still boots when NODE_ENV explicitly says development', () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== 'NODE_ENV' && value !== undefined) env[key] = value;
    }
    env.NODE_ENV = 'development';

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--eval', "import('./src/config/env.js')"],
      { encoding: 'utf8', env, cwd: process.cwd() },
    );

    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
  });
});
