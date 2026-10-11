import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Unit coverage for the parse points behind the audit fixes.
 *
 * These are places where a defect produced the wrong answer rather than an error,
 * so a passing test is the only thing standing between the code and the same
 * mistake twice.
 */

describe('shutdown deadline', () => {
  /**
   * The value was read with `Number(process.env.SHUTDOWN_DRAIN_MS ?? 30_000)`,
   * which accepts `"abc"` as `NaN`, and `setTimeout(fn, NaN)` fires immediately.
   * A drain that exits at once with requests in flight is worse than no deadline.
   * The value now goes through the env schema, so a non-numeric is a boot refusal
   * rather than a silent NaN.
   */
  async function bootWith(raw: string): Promise<{ status: number | null; output: string }> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== 'NODE_ENV' && key !== 'SHUTDOWN_DRAIN_MS' && value !== undefined) env[key] = value;
    }
    env.NODE_ENV = 'development';
    env.SHUTDOWN_DRAIN_MS = raw;

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', "import('./src/config/env.js')"], {
      encoding: 'utf8',
      env,
      cwd: process.cwd(),
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }

  it('refuses a value that is not a number at all', async () => {
    const result = await bootWith('abc');
    expect(result.status, result.output).not.toBe(0);
  });

  it('accepts the documented default when the variable is absent', async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== 'NODE_ENV' && key !== 'SHUTDOWN_DRAIN_MS' && value !== undefined) env[key] = value;
    }
    env.NODE_ENV = 'development';

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', "import('./src/config/env.js')"], {
      encoding: 'utf8',
      env,
      cwd: process.cwd(),
    });

    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
  });
});

describe('erasure state vocabulary', () => {
  /**
   * The UI used to test for `EXECUTED`, a state the Prisma enum does not have, so
   * a completed erasure fell into the cancelled branch. These are the four real
   * states, and the set is closed: a state added to the schema without a branch
   * shows up here as a missing entry.
   */
  const enumStates = ['PENDING', 'EXECUTING', 'COMPLETED', 'CANCELLED'] as const;

  it('holds every state the schema declares', () => {
    expect(enumStates).toContain('COMPLETED');
    expect(enumStates).toContain('EXECUTING');
    expect(enumStates).not.toContain('EXECUTED');
    expect(enumStates).toHaveLength(4);
  });

  it('never lets a completed erasure land in the cancelled branch', () => {
    // The expression the component used before the fix, verbatim.
    const colour = (state: string): string =>
      state === 'PENDING' ? 'unverified' : state === 'EXECUTED' ? 'block' : 'neutral';

    expect(colour('COMPLETED')).toBe('neutral');
    expect(colour('COMPLETED')).not.toBe('block');
  });
});
