import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '../database/prisma.js';

const run = promisify(execFile);

/**
 * Refuses to start against a schema the binary was not built for.
 *
 * The container entrypoint runs `prisma migrate deploy` before the server, so this
 * should never fire. It exists because "should never" is how outages start: a
 * platform that overrides the entrypoint, a deploy run outside the image, a
 * migration that fails on a replica which then starts anyway because the failure was
 * only logged.
 *
 * Every failure mode of "new binary, old schema" looks the same from the outside. The
 * service starts, `/health` answers ok because it does not touch the database, and
 * the first request that reads a column added last week fails with a Prisma error
 * naming a table the customer has never heard of. Depending entirely on the deploy
 * having done the right thing turns that into a 500 during a deploy rather than a
 * refusal to start.
 */
export interface SchemaCheck {
  ok: boolean;
  detail: string;
}

/**
 * The migration this build expects to have been applied.
 *
 * Read from the schema itself rather than a number written by hand, because a
 * hand-maintained constant drifts the first time a migration is added elsewhere and
 * then sits there claiming the wrong thing.
 */
export async function checkSchemaIsCurrent(): Promise<SchemaCheck> {
  try {
    /**
     * `_prisma_migrations` is the table the migrate engine maintains. A migration that
     * is recorded as finished but not rolled back is `finished_at IS NOT NULL AND
     * rolled_back_at IS NULL`.
     */
    const applied = await prisma.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );

    const appliedCount = applied[0]?.count ?? 0;

    if (appliedCount === 0) {
      return {
        ok: false,
        detail:
          'No migrations are recorded as applied. Run `prisma migrate deploy` before starting the API; an empty database with a built binary serves nothing useful.',
      };
    }

    /**
     * Asked of the migration engine rather than counted in the application, because
     * counting rows here would only ever confirm that whatever is in the table is in
     * the table.
     */
    const { stdout } = await run('npx', ['prisma', 'migrate', 'status'], {
      timeout: 30_000,
      windowsHide: true,
    });

    if (/up to date/i.test(stdout)) {
      return { ok: true, detail: `schema is current, ${appliedCount} migration(s) applied` };
    }

    return { ok: false, detail: 'The database has not had every migration applied.' };
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