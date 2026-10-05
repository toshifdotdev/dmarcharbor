import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';

/**
 * One owner per domain name, across every workspace.
 *
 * `Domain.name` used to be unique only per client. Two tenants could therefore
 * both add the same name, both reach VERIFIED, and report routing would resolve
 * that name to two rows and return `ambiguous_domain` from then on. The result was
 * that *neither* tenant received another report for that domain, permanently, and
 * nothing on either dashboard said why. A single tenant naming a domain another
 * tenant monitors was enough to silently blind them.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(label: string): Promise<{
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  clientId: string;
}> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: `${label} Owner`, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: `${label} Workspace`,
    slug: `${label}-workspace-${Date.now()}-${fixtureId}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  await grantPlan(created.body.id as string);

  const client = await agent
    .post(`/api/workspaces/${created.body.id}/clients`)
    .send({ name: `${label} Client`, slug: `${label}-client-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);

  return { agent, organizationId: created.body.id as string, clientId: client.body.id as string };
}

async function addDomain(agent: ReturnType<typeof request.agent>, organizationId: string, clientId: string, name: string) {
  return agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`).send({ name });
}

async function seedDomain(clientId: string, name: string, slug: string, createdAt?: Date) {
  const row = await prisma.domain.create({
    data: { clientId, name, slug, ...(createdAt ? { createdAt } : {}) },
  });
  return { id: row.id, name: row.name };
}

/** Thrown to leave the transaction early, which is how it gets rolled back. */
class RollbackSentinel extends Error {}

/**
 * Splits a migration file into single commands.
 *
 * Only needed because the driver sends a prepared statement, and Postgres will not
 * accept several commands in one prepared statement. This chunks the file; it does
 * not rewrite it, so what runs is still the migration's own SQL.
 *
 * Two things are tracked, because both appear in this migration and both would
 * otherwise be split in the wrong place:
 *
 * - Dollar quoting, since the file ends in a `DO $$ ... $$` block whose
 *   `RAISE NOTICE` statements are semicolon separated.
 * - Line comments, since the header explains the bug in prose and a sentence
 *   containing a semicolon is not a statement boundary.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let inDollarQuote = false;
  let inLineComment = false;
  let index = 0;

  while (index < sql.length) {
    if (inLineComment) {
      const char = sql[index];
      buffer += char;
      index += 1;
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inDollarQuote) {
      if (sql.startsWith('$$', index)) {
        buffer += '$$';
        index += 2;
        inDollarQuote = false;
        continue;
      }
      buffer += sql[index];
      index += 1;
      continue;
    }

    if (sql.startsWith('--', index)) {
      buffer += '--';
      index += 2;
      inLineComment = true;
      continue;
    }

    if (sql.startsWith('$$', index)) {
      buffer += '$$';
      inDollarQuote = true;
      index += 2;
      continue;
    }

    if (sql[index] === ';') {
      if (buffer.trim()) statements.push(buffer.trim());
      buffer = '';
      index += 1;
      continue;
    }

    buffer += sql[index];
    index += 1;
  }

  if (buffer.trim()) statements.push(buffer.trim());

  return statements.filter((statement) => {
    // Drop chunks that are only comments, which are not executable on their own.
    const withoutComments = statement.replace(/^(?:\s*--[^\n]*\n)+/, '').trim();
    return withoutComments.length > 0;
  });
}

const later = (offsetMs = 60_000): Date => new Date(Date.now() + offsetMs);

describe('global domain name uniqueness', () => {
  beforeEach(resetDatabase);

  it('refuses a name another workspace already holds, and says why', async () => {
    const first = await workspace('owner');
    const second = await workspace('intruder');

    expect((await addDomain(first.agent, first.organizationId, first.clientId, 'victim.example')).status).toBe(201);

    const response = await addDomain(second.agent, second.organizationId, second.clientId, 'victim.example');

    expect(response.status).toBe(409);
    /**
     * The message is the product here. A bare "conflict" would leave an operator
     * deciding between a typo, a bug and a support ticket.
     */
    expect(response.body.error.message).toContain('already monitored by another workspace');
    expect(response.body.error.domain).toBe('victim.example');

    // The refused add left nothing behind for the victim to trip over later.
    expect(await prisma.domain.count({ where: { name: 'victim.example' } })).toBe(1);
  });

  it('stores the name lowercased, so case cannot smuggle in a second row', async () => {
    const owner = await workspace('case');

    const response = await addDomain(owner.agent, owner.organizationId, owner.clientId, 'Mixed-Case.Example');

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('mixed-case.example');
  });

  it('treats a differently cased name as the same name', async () => {
    const owner = await workspace('tone');
    const other = await workspace('tone2');

    expect((await addDomain(owner.agent, owner.organizationId, owner.clientId, 'Case-Collision.example')).status).toBe(201);
    expect((await addDomain(other.agent, other.organizationId, other.clientId, 'CASE-COLLISION.EXAMPLE')).status).toBe(409);
  });

  it('returns the existing row instead of a duplicate when the same client adds it twice', async () => {
    const owner = await workspace('twice');

    const first = await addDomain(owner.agent, owner.organizationId, owner.clientId, 'Repeat.Example');
    const second = await addDomain(owner.agent, owner.organizationId, owner.clientId, 'repeat.example');

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.domain.count({ where: { name: 'repeat.example' } })).toBe(1);
  });
});

/**
 * The migration that enforces this has to repair what is already there, and a
 * repair migration is the part most likely to be wrong precisely because nobody
 * runs it against the state that motivated it. These tests seed the broken state,
 * run the migration's own file, and assert the outcome.
 */
describe('domain name migration repair', () => {
  const migrationPath = join(
    process.cwd(),
    'prisma',
    'migrations',
    '20261006090000_domain_name_uniqueness',
    'migration.sql',
  );

  beforeEach(resetDatabase);

  /**
   * The constraint comes down for every test in this block.
   *
   * Seeding the broken state means inserting exactly the rows the unique index
   * forbids, so it cannot still be in place while the fixtures are created.
   * `afterEach` puts it back.
   */
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "domain_name_key"');
  });

  /**
   * The index is dropped outside the repair transaction, because the duplicates
   * have to exist before the migration runs.
   *
   * The truncate comes first: a test that seeded duplicates leaves them behind, and
   * the index cannot be rebuilt while they are still there.
   */
  afterEach(async () => {
    await resetDatabase();
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "domain_name_key" ON "domain"("name")');
  });

  /**
   * Reads the migration and runs it verbatim inside a transaction that is always
   * rolled back.
   *
   * Verbatim rather than copied into this test, because a copy is a second
   * implementation which can agree with itself while both disagree with the
   * migration that will actually run against production data.
   *
   * Assertions run inside the transaction, since the state they check is the state
   * the repair produced and it is gone by the time it returns.
   */
  async function withRepair(assert: (tx: typeof prisma) => Promise<void>): Promise<void> {
    /**
     * One substitution, and it is a no-op in production.
     *
     * The migration drops the old per client index, which exists on a database
     * that has not had this migration applied yet. This one already has, so the
     * statement is made conditional for the re-run. In production the index is
     * there and `IF EXISTS` changes nothing about what happens.
     *
     * The *new* index is deliberately left alone: it is dropped below, so the
     * migration rebuilding it is a real check that the repaired rows actually
     * satisfy the constraint, rather than a statement quietly skipped.
     */
    const statements = splitStatements(readFileSync(migrationPath, 'utf8')).map((statement) =>
      statement.replace('DROP INDEX "domain_clientId_name_key"', 'DROP INDEX IF EXISTS "domain_clientId_name_key"'),
    );

    expect(statements.length).toBeGreaterThan(4);
    expect(statements.some((statement) => statement.includes('CREATE UNIQUE INDEX "domain_name_key"'))).toBe(true);

    await prisma.$transaction(
      async (tx) => {
        // The constraint comes down first, because the duplicates these tests seed
        // are exactly what it forbids.
        await tx.$executeRawUnsafe('DROP INDEX IF EXISTS "domain_name_key"');
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
        await assert(tx as unknown as typeof prisma);
        throw new RollbackSentinel();
      },
      { timeout: 30_000 },
    ).catch((error: unknown) => {
      if (!(error instanceof RollbackSentinel)) throw error;
    });
  }

  it('keeps the oldest row on the plain name and renames the later one', async () => {
    const first = await workspace('migfirst');
    const second = await workspace('migsecond');

    const older = await seedDomain(first.clientId, 'shared.example', 'shared-older');
    const newer = await seedDomain(second.clientId, 'shared.example', 'shared-newer', later());

    await withRepair(async (tx) => {
      const afterOlder = await tx.domain.findUnique({ where: { id: older.id } });
      const afterNewer = await tx.domain.findUnique({ where: { id: newer.id } });

      expect(afterOlder?.name).toBe('shared.example');
      expect(afterNewer?.name).not.toBe('shared.example');
      expect(afterNewer?.name).toMatch(/^shared\.example\.duplicate-[0-9a-f]{8}$/);

      // Every surviving name is canonical, which is what lets the index be plain.
      const all = await tx.domain.findMany({ select: { name: true } });
      for (const row of all) {
        expect(row.name).toBe(row.name.toLowerCase());
      }
    });
  });

  it('renames rather than deletes, so the later tenant keeps its data', async () => {
    const first = await workspace('keepfirst');
    const second = await workspace('keepsecond');

    const older = await seedDomain(first.clientId, 'kept.example', 'kept-older');
    const newer = await seedDomain(second.clientId, 'kept.example', 'kept-newer', later());

    // Something attached to the losing row, which a delete would have destroyed.
    await prisma.scan.create({
      data: { domainId: newer.id, status: 'COMPLETED', score: 92 },
    });

    await withRepair(async (tx) => {
      expect(await tx.domain.count({ where: { id: newer.id } })).toBe(1);
      expect(await tx.scan.count({ where: { domainId: newer.id } })).toBe(1);
      expect(await tx.scan.count({ where: { domainId: older.id } })).toBe(0);
    });
  });

  it('folds rows differing only by case into one instead of letting them collide', async () => {
    const first = await workspace('casefirst');
    const second = await workspace('casesecond');

    await seedDomain(first.clientId, 'Fold.Example', 'fold-plain');
    await seedDomain(second.clientId, 'FOLD.EXAMPLE', 'fold-variant', later());

    await withRepair(async (tx) => {
      // The index having been rebuilt at all is itself proof the repair resolved
      // the collision, since these two rows were folded before it could be created.
      const rows = await tx.domain.findMany({
        where: { slug: { in: ['fold-plain', 'fold-variant'] } },
        select: { name: true },
      });

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.name)).size).toBe(2);

      const renamed = rows.find((row) => row.name.includes('duplicate-'));
      expect(renamed?.name).toMatch(/^fold\.example\.duplicate-[0-9a-f]{8}$/);
      expect(renamed?.name).toBe(renamed?.name.toLowerCase());
    });
  });

  it('renames every duplicate of a name, not just the second', async () => {
    const one = await workspace('triple1');
    const two = await workspace('triple2');
    const three = await workspace('triple3');

    await seedDomain(one.clientId, 'triple.example', 'triple-1');
    await seedDomain(two.clientId, 'triple.example', 'triple-2', later());
    await seedDomain(three.clientId, 'triple.example', 'triple-3', later(120_000));

    await withRepair(async (tx) => {
      const rows = await tx.domain.findMany({
        where: { slug: { startsWith: 'triple-' } },
        select: { name: true },
      });

      expect(rows).toHaveLength(3);

      // Exactly one owner, and everyone else is still present under a new name.
      expect(rows.filter((row) => row.name === 'triple.example')).toHaveLength(1);
      expect(rows.filter((row) => row.name.includes('duplicate-'))).toHaveLength(2);
      // Distinct names, or the rebuilt unique index would have failed outright.
      expect(new Set(rows.map((row) => row.name)).size).toBe(3);
    });
  });

  it('lowercases a legacy name that has no duplicate, not only the ones it renamed', async () => {
    const only = await workspace('legacycase');

    /**
     * The subtle version of the bug. Canonicalising only the rows that were renamed
     * would leave this one as `Legacy.Example`, and a plain unique index would then
     * accept `legacy.example` beside it, which is precisely the ambiguity this
     * migration exists to remove.
     */
    await seedDomain(only.clientId, 'Legacy.Example', 'legacy-case');

    await withRepair(async (tx) => {
      const row = await tx.domain.findFirst({ where: { slug: 'legacy-case' }, select: { name: true } });

      expect(row?.name).toBe('legacy.example');
      expect(row?.name).not.toContain('duplicate-');
    });
  });

  it('leaves a clean table alone', async () => {
    const only = await workspace('cleanonly');
    await seedDomain(only.clientId, 'already-clean.example', 'already-clean');

    await withRepair(async (tx) => {
      const rows = await tx.domain.findMany({ where: { clientId: only.clientId }, select: { name: true } });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('already-clean.example');
      expect(rows[0]?.name).not.toContain('duplicate-');
    });
  });

  it('reports every rename rather than renaming silently', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    /**
     * A data repair an operator cannot see is a data repair nobody will ever check.
     * The count of affected tenants matters, and the migration says so out loud
     * rather than leaving it to be discovered from a support ticket.
     */
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/domain\(s\) renamed/);
    expect(sql).toContain('clientId');
  });
});
