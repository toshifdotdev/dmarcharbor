import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shippedMigrationCount } from '../src/services/schema-check.service.js';

/**
 * The check that decides whether the API refuses to boot.
 *
 * Getting this wrong in the permissive direction serves 500s on the first request that
 * touches a missing column. Getting it wrong in the strict direction is worse and
 * quieter: the process exits 1 forever and nothing works at all. That is not
 * hypothetical. The first version shelled out to `prisma migrate status`, `npx` failed
 * without network access, and the container would not start.
 *
 * So the two properties worth testing are that a real database passes, and that the
 * count it reads is the number of migrations actually on disk.
 */

const created: string[] = [];

function migrationsDir(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'schema-check-'));
  created.push(root);

  for (const name of names) {
    mkdirSync(join(root, name));
  }

  return root;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('schema check', () => {
  it('counts the migration directories actually present', () => {
    const dir = migrationsDir(['20260101000000_one', '20260102000000_two', '20260103000000_three']);
    expect(shippedMigrationCount(dir)).toBe(3);
  });

  it('returns null rather than guessing when the directory is absent', () => {
    /**
     * Some test and bundling environments have no `prisma` directory at all. Guessing
     * zero there would make the comparison vacuous and the check would pass
     * unconditionally, which is the failure mode this function exists to avoid.
     */
    expect(shippedMigrationCount(join(tmpdir(), 'definitely-not-here-marcharbor'))).toBeNull();
  });

});
