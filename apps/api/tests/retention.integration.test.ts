import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { purgeExpiredData } from '../src/services/retention.service.js';
import { runRetentionOnce } from '../src/scheduler/retention-scheduler.js';
import { rateLimitStoreFor } from '../src/middleware/postgres-rate-limit-store.js';

/**
 * Retention for the tables that hold customer data.
 *
 * Reports and forensic reports always had a sweeper, and Phase 4 made the service
 * publish those windows rather than quoting a plan figure that governed nothing.
 * These four had no sweeper at all, so a customer's full dataset, a checkout
 * response body, an abandoned PKCE verifier and the provider's raw webhook body all
 * sat in the database for ever. Three of the four already had an index built for a
 * query nobody was making.
 */

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_event", "subscription", "idempotency_record", "sso_auth_request", "sso_connection", "export_job", "erasure_request", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

const day = 24 * 60 * 60 * 1000;

async function seedOrganization(): Promise<string> {
  const id = `retention-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.organization.create({ data: { id, name: 'Retention Agency', slug: id, createdAt: new Date() } });
  return id;
}

async function seedExportJob(organizationId: string, purgeAfter: Date): Promise<string> {
  const job = await prisma.exportJob.create({
    data: {
      organizationId,
      requestedById: 'user-that-may-not-exist',
      scope: 'ORGANIZATION',
      scopeLabel: 'Everything',
      purgeAfter,
      downloadExpiresAt: purgeAfter,
    },
    select: { id: true },
  });
  return job.id;
}

describe('data retention sweep', () => {
  beforeEach(resetDatabase);

  it('removes an export job once its retention date has passed', async () => {
    const organizationId = await seedOrganization();
    const expired = await seedExportJob(organizationId, new Date(Date.now() - day));
    const fresh = await seedExportJob(organizationId, new Date(Date.now() + 6 * day));

    const swept = await purgeExpiredData();

    expect(swept.exportJobs).toBe(1);
    expect(await prisma.exportJob.findUnique({ where: { id: expired } })).toBeNull();
    /**
     * A job inside its window survives, because the download link is still meant to
     * work. Sweeping on age rather than on `purgeAfter` would break exports people
     * had not finished with.
     */
    expect(await prisma.exportJob.findUnique({ where: { id: fresh } })).not.toBeNull();
  });

  it('empties a billing payload instead of deleting the row that stops a replay', async () => {
    const organizationId = await seedOrganization();
    const old = Date.now() - 200 * day;

    const event = await prisma.billingEvent.create({
      data: {
        providerEventId: 'evt-old-payload',
        provider: 'RAZORPAY',
        type: 'subscription.activated',
        organizationId,
        payload: { customer: { name: 'Priya Shah', email: 'priya@example.com' } },
        occurredAt: new Date(old),
        createdAt: new Date(old),
      },
      select: { id: true },
    });

    const recent = await prisma.billingEvent.create({
      data: {
        providerEventId: 'evt-recent-payload',
        provider: 'RAZORPAY',
        type: 'subscription.activated',
        organizationId,
        payload: { customer: { name: 'Still Inside The Window', email: 'recent@example.com' } },
        occurredAt: new Date(),
        createdAt: new Date(),
      },
      select: { id: true },
    });

    const swept = await purgeExpiredData();

    expect(swept.billingPayloads).toBe(1);

    const cleared = await prisma.billingEvent.findUniqueOrThrow({ where: { id: event.id } });
    /**
     * The row stays, and that is the whole point.
     *
     * `providerEventId` is unique and is what makes webhook delivery idempotent.
     * Deleting the row would let a provider retry an old event and have it applied
     * twice, so the payload is emptied and the evidence is kept.
     */
    expect(cleared.payload).toBeNull();
    expect(cleared.providerEventId).toBe('evt-old-payload');
    expect(cleared.type).toBe('subscription.activated');
    expect(cleared.occurredAt).toEqual(new Date(old));

    const stored = JSON.stringify(await prisma.billingEvent.findMany());
    expect(stored).not.toContain('priya@example.com');

    const kept = await prisma.billingEvent.findUniqueOrThrow({ where: { id: recent.id } });
    expect(kept.payload).not.toBeNull();
  });

  it('clears a billing payload to SQL null rather than the JSON value null', async () => {
    const organizationId = await seedOrganization();
    const old = Date.now() - 200 * day;

    const event = await prisma.billingEvent.create({
      data: {
        providerEventId: 'evt-json-null-check',
        provider: 'PADDLE',
        type: 'subscription.created',
        organizationId,
        payload: { email: 'gone@example.com' },
        occurredAt: new Date(old),
        createdAt: new Date(old),
      },
      select: { id: true },
    });

    await purgeExpiredData();

    /**
     * On a nullable `Json` column Prisma writes a bare `null` as JSON null, which
     * round trips as the four characters `null` rather than as an absent value. That
     * would leave the customer's data readable as a string and make the column look
     * populated to anything that checks for non-null.
     */
    const raw = await prisma.$queryRawUnsafe<{ payload_is_null: boolean }[]>(
      'SELECT payload IS NULL AS payload_is_null FROM "billing_event" WHERE id = $1',
      event.id,
    );
    expect(raw[0]?.payload_is_null).toBe(true);

    expect(JSON.stringify(await prisma.billingEvent.findMany())).not.toContain('null"');
  });

  it('removes replay records and abandoned sign-ins once past their windows', async () => {
    const organizationId = await seedOrganization();

    const staleRecord = await prisma.idempotencyRecord.create({
      data: {
        key: 'stale-key',
        organizationId,
        requestHash: 'hash',
        statusCode: 201,
        responseBody: { clientId: 'c-1', dnsVerificationValue: 'dmarc-harbor-verification=abc' },
        createdAt: new Date(Date.now() - 3 * day),
      },
      select: { id: true },
    });

    const freshRecord = await prisma.idempotencyRecord.create({
      data: { key: 'fresh-key', organizationId, requestHash: 'hash', createdAt: new Date() },
      select: { id: true },
    });

    const connection = await prisma.ssoConnection.create({
      data: {
        organizationId,
        label: 'Okta',
        protocol: 'SAML',
        issuer: 'https://idp.example.com/saml',
        entryPoint: 'https://idp.example.com/sso',
        clientId: 'dmarc-harbor',
        clientSecretEncrypted: 'encrypted',
      },
      select: { id: true },
    });

    const abandoned = await prisma.ssoAuthRequest.create({
      data: { connectionId: connection.id, verifier: 'stale-pkce-verifier', createdAt: new Date(Date.now() - 3 * day) },
      select: { id: true },
    });

    const inFlight = await prisma.ssoAuthRequest.create({
      data: { connectionId: connection.id, verifier: 'live-pkce-verifier', createdAt: new Date() },
      select: { id: true },
    });

    const swept = await purgeExpiredData();

    expect(swept.idempotencyRecords).toBe(1);
    expect(swept.ssoAuthRequests).toBe(1);

    expect(await prisma.idempotencyRecord.findUnique({ where: { id: staleRecord.id } })).toBeNull();
    expect(await prisma.ssoAuthRequest.findUnique({ where: { id: abandoned.id } })).toBeNull();

    // A sign-in in progress, and a replay record inside its window, are untouched.
    expect(await prisma.idempotencyRecord.findUnique({ where: { id: freshRecord.id } })).not.toBeNull();
    expect(await prisma.ssoAuthRequest.findUnique({ where: { id: inFlight.id } })).not.toBeNull();
  });

  it('keeps the audit trail and erasure certificates, which are the evidence', async () => {
    const organizationId = await seedOrganization();
    const longAgo = new Date(Date.now() - 400 * day);

    await prisma.auditLog.create({
      data: { organizationId, action: 'ERASURE_COMPLETED', targetType: 'erasure_request', targetId: 'e1', createdAt: longAgo },
    });

    const certificate = await prisma.erasureRequest.create({
      data: {
        id: 'erasure-proof-1',
        requestedById: 'someone',
        scope: 'ORGANIZATION',
        state: 'COMPLETED',
        purgeAfter: longAgo,
        completedAt: longAgo,
        createdAt: longAgo,
        certificate: { version: 1, statement: 'Personal data held for this scope was deleted.' },
      },
      select: { id: true },
    });

    await purgeExpiredData();

    /**
     * Both are deliberately unswept, and both are deliberate promises.
     *
     * The audit trail is what shows an erasure happened, and the certificate is what
     * a regulator asks for years later. Phase 4 made the compliance pack state the
     * audit trail has no automatic expiry rather than imply a window nobody
     * enforces; a sweeper here would make that document wrong again.
     */
    expect(await prisma.auditLog.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.erasureRequest.findUnique({ where: { id: certificate.id } })).not.toBeNull();
  });

  it('reports zeroes rather than throwing on an empty database', async () => {
    await expect(purgeExpiredData()).resolves.toEqual({
      exportJobs: 0,
      idempotencyRecords: 0,
      ssoAuthRequests: 0,
      billingPayloads: 0,
      rateLimitBuckets: 0,
    });
  });

  it('removes expired rate limit counters and leaves live ones alone', async () => {
    /**
     * Shared counters are the one thing in this table set that is not customer data:
     * a row is a request count against an IP or an identifier, and it decides whether
     * the next request is allowed. Nothing reads it for reporting, so the only correct
     * end of a row is the moment its window closes.
     *
     * The mistake to avoid is sweeping live windows as well as expired ones. A counter
     * whose `resetAt` is in the future is an enforced limit, and deleting it hands the
     * caller a fresh allowance - so a sweep that clears them converts a rate limit into
     * no rate limit at exactly the moment traffic is high enough to need one.
     */
    const store = rateLimitStoreFor('retention-probe');
    const expired = `retention-expired-${Date.now()}`;
    const live = `retention-live-${Date.now()}`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "rate_limit_bucket" ("key", "limiter", "hits", "resetAt")
       VALUES ($1, 'retention-probe', 9, $2), ($3, 'retention-probe', 2, $4)`,
      expired,
      new Date(Date.now() - day),
      live,
      new Date(Date.now() + day),
    );

    expect((await purgeExpiredData()).rateLimitBuckets).toBeGreaterThanOrEqual(1);

    const survivors = await prisma.$queryRawUnsafe<Array<{ key: string }>>(
      `SELECT "key" FROM "rate_limit_bucket" WHERE "key" = ANY($1::text[])`,
      [expired, live],
    );
    expect(survivors.map((row) => row.key)).toEqual([live]);

    await store.resetAll();
  });

  it('is safe to run twice, which is what a scheduler and a manual call will do', async () => {
    const organizationId = await seedOrganization();
    await seedExportJob(organizationId, new Date(Date.now() - day));

    expect((await purgeExpiredData()).exportJobs).toBe(1);
    expect((await purgeExpiredData()).exportJobs).toBe(0);
  });

  it('survives a scheduler pass that finds nothing to do', async () => {
    await expect(runRetentionOnce()).resolves.toMatchObject({ exportJobs: expect.any(Number) });
  });
});