import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../database/prisma.js';

/**
 * Refuses to start against a schema the binary was not built for.
 *
 * The container entrypoint runs `prisma migrate deploy` before the server, so this
 * should never fire. It exists because "should never" is how outages start: a platform
 * that overrides the entrypoint, a deploy run outside the image, a migration that fails
 * on one replica which then starts anyway because the failure was only logged.
 *
 * Every failure mode of "new binary, old schema" looks the same from outside. The
 * service starts, `/health` answers ok because it does not touch the database, and the
 * first request that reads a column added last week fails with a Prisma error naming a
 * table the customer has never heard of.
 *
 * An earlier version of this shelled out to `prisma migrate status`, which was a
 * better check and made the container unbootable: `npx` failed without network access
 * and the process exited 1 before it had served a single request. A safety check that
 * takes the service down when it cannot reach the network is not a safety check.
 */
export interface SchemaCheck {
  ok: boolean;
  detail: string;
}

/**
 * How many migrations this build carries.
 *
 * Counted from the `prisma/migrations` directory that is copied into the image, rather
 * than written down by hand or asked of the CLI. Both of those drift: a hand-maintained
 * constant is wrong the first time a migration is added elsewhere, and the CLI needs
 * network access and a working `npx`.
 *
 * Returns null when the directory is absent, which is the case in some test and
 * bundling environments. The check then falls back to "are any migrations applied at
 * all", which still catches the empty database this exists to prevent.
 */
export function shippedMigrationCount(prismaDir = join(process.cwd(), 'prisma', 'migrations')): number | null {
  try {
    return readdirSync(prismaDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return null;
  }
}

export async function checkSchemaIsCurrent(): Promise<SchemaCheck> {
  try {
    /**
     * Read from the migrate engine's own table.
     *
     * A migration that is recorded as finished and not rolled back has been applied to
     * this database. Anything else - failed, or rolled back after a partial run - has
     * not, and a database carrying one of those is exactly the state where starting is
     * the wrong move.
     */
    const rows = await prisma.$queryRawUnsafe<{ finished: number; unfinished: number }[]>(
      `SELECT
         count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS finished,
         count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished
       FROM "_prisma_migrations"`,
    );

    const finished = rows[0]?.finished ?? 0;
    const unfinished = rows[0]?.unfinished ?? 0;

    if (unfinished > 0) {
      return {
        ok: false,
        detail: `${unfinished} migration(s) are recorded as started but not finished. Resolve them with \`prisma migrate resolve\` before starting this build.`,
      };
    }

    if (finished === 0) {
      return {
        ok: false,
        detail:
          'No migrations are recorded as applied. Run `prisma migrate deploy` before starting the API; an empty database with a built binary serves nothing useful.',
      };
    }

    const shipped = shippedMigrationCount();

    if (shipped === null) {
      return { ok: true, detail: `schema has ${finished} migration(s) applied; migration directory not present to compare against` };
    }

    /**
     * Behind, rather than merely different.
     *
     * A database may legitimately have *more* migrations than this build carries, when
     * an older version of the image is rolled back. That is a real operational situation
     * and a loud refusal here would strand the rollback, so only a shortfall is treated
     * as a failure.
     */
    if (finished < shipped) {
      return {
        ok: false,
        detail: `This build carries ${shipped} migration(s) and the database has ${finished}. Run \`prisma migrate deploy\` before starting the API.`,
      };
    }

    return { ok: true, detail: `schema is current, ${finished} migration(s) applied of ${shipped} shipped` };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error
          ? `Could not confirm the schema is current: ${error.message}`
          : 'Could not confirm the schema is current.',
    };
  }
}