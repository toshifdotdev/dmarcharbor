import request from 'supertest';
import { vi } from 'vitest';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkSchemaIsCurrent } from '../src/services/schema-check.service.js';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';

/**
 * The check that decides whether the API refuses to boot, against a real database.
 *
 * The filesystem half is unit tested elsewhere. This half cannot be, and the attempt
 * was instructive: a unit test asserting the message mentions migrations passes when
 * the database is reachable and fails when it is not, because the connection-failure
 * path returns a different sentence. A unit test with a hidden database dependency is
 * a test that fails for a reason nobody can see, which is why this one lives here.
 *
 * The first version of the check shelled out to `prisma migrate status`. `npx` failed
 * without network access and the container exited 1 before serving a request, so the
 * strict direction has to be tested as carefully as the permissive one.
 */

describe('schema check against the database', () => {
  beforeEach(async () => {
    // Nothing to reset: this only reads the migrate engine's own table.
  });

  it('accepts a database whose migrations are all applied', async () => {
    const result = await checkSchemaIsCurrent();

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/schema is current/i);
  });

  it('names the command to run when it refuses', async () => {
    /**
     * Forced by pretending nothing is applied. The point is the message an operator
     * reads at 3am with a restart loop: it has to say what to do, not merely that
     * something is wrong.
     */
    const real = prisma.$queryRawUnsafe;
    const spy = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{ finished: 0, unfinished: 0 }] as never);

    try {
      const result = await checkSchemaIsCurrent();

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('prisma migrate deploy');
    } finally {
      spy.mockRestore();
      expect(typeof real).toBe('function');
    }
  });

  it('refuses when a migration was started but never finished', async () => {
    const spy = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{ finished: 5, unfinished: 1 }] as never);

    try {
      const result = await checkSchemaIsCurrent();

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/not finished/i);
      expect(result.detail).toContain('migrate resolve');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses when the database is behind the build', async () => {
    const spy = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{ finished: 2, unfinished: 0 }] as never);

    try {
      const result = await checkSchemaIsCurrent();

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/carries \d+ migration/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('tolerates a database ahead of the build, which is a rollback', async () => {
    /**
     * Rolling back to an older image is a legitimate operational action. A loud refusal
     * here would strand it with no way forward except another migration forward, so
     * only a shortfall counts as a failure.
     */
    const spy = vi
      .spyOn(prisma, '$queryRawUnsafe')
      .mockResolvedValueOnce([{ finished: 9_999, unfinished: 0 }] as never);

    try {
      const result = await checkSchemaIsCurrent();

      expect(result.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('serves the liveness probe without touching the database', async () => {
    /**
     * `/health` answers without the database and `/ready` does not, which is the whole
     * reason the container healthcheck uses the first one: a container should not be
     * marked unhealthy because a dependency it cannot restart is unavailable.
     */
    const health = await request(app).get('/api/health');
    const ready = await request(app).get('/api/ready');

    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database.status).toBe('ok');
  });
});