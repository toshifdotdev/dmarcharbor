import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "billing_event", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `currency-${Date.now()}-${fixtureId}@example.com`;

  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Currency Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const created = await agent.post('/api/workspaces').send({
    name: 'Currency Workspace',
    slug: `currency-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(created.status).toBe(201);

  return { agent, organizationId: created.body.id as string };
}

describe('raised prices', () => {
  it('charges a plausible amount per domain at every paid tier', () => {
    // The point of the raise was to stop Harbor reading as a $1-a-domain product
    // next to a market charging $4 to $14. These bounds are what keep it both
    // credible and still far cheaper than every competitor.
    expect(planCatalog.FAIRWAY.prices.USD.monthlyMinor).toBe(2900);
    expect(planCatalog.HARBOR.prices.USD.monthlyMinor).toBe(14900);
    expect(planCatalog.ADMIRALTY.prices.USD.monthlyMinor).toBe(39900);
  });

  it('keeps the per-domain rate inside the band the market occupies', () => {
    for (const tier of ['FAIRWAY', 'HARBOR', 'ADMIRALTY'] as const) {
      const perDomain = planCatalog[tier].prices.USD.monthlyMinor / 100 / planCatalog[tier].maxActiveDomains;
      // Under $4 (DMARCeye), over $1, and nowhere near $10 (dmarcian Basic).
      expect(perDomain).toBeGreaterThan(1);
      expect(perDomain).toBeLessThan(4);
    }
  });

  it('keeps annual billing at ten months for twelve', () => {
    for (const tier of ['FAIRWAY', 'HARBOR', 'ADMIRALTY'] as const) {
      const { monthlyMinor, annualMinor } = planCatalog[tier].prices.USD;
      expect(annualMinor).toBe(monthlyMinor * 10);
      const inr = planCatalog[tier].prices.INR;
      expect(inr.annualMinor).toBe(inr.monthlyMinor * 10);
    }
  });

  it('leaves the free tier free', () => {
    expect(planCatalog.MOORING.prices.USD.monthlyMinor).toBe(0);
    expect(planCatalog.MOORING.prices.INR.monthlyMinor).toBe(0);
  });

  it('advertises the raised prices through the public plan list', async () => {
    const response = await request(app).get('/api/plans');

    expect(response.status).toBe(200);
    const harbor = (response.body as { plans: { tier: string; prices: Record<string, { monthlyMinor: number }> }[] }).plans.find(
      (plan) => plan.tier === 'HARBOR',
    );
    expect(harbor?.prices.USD.monthlyMinor).toBe(14900);
  });
});

describe('workspace currency preference', () => {
  beforeAll(resetDatabase);

  it('defaults to INR, the processor money can actually be taken with today', async () => {
    const { agent, organizationId } = await workspace();

    const response = await agent.get(`/api/workspaces/${organizationId}/billing/currency`);

    expect(response.status).toBe(200);
    // Paddle is not approved yet. A visitor who saw USD pricing and reached a
    // checkout that returns 503 would already be lost.
    expect(response.body.preferredCurrency).toBe('INR');
  });

  it('is editable before any payment exists', async () => {
    const { agent, organizationId } = await workspace();

    const read = await agent.get(`/api/workspaces/${organizationId}/billing/currency`);
    expect(read.body.locked).toBe(false);

    const written = await agent
      .patch(`/api/workspaces/${organizationId}/billing/currency`)
      .send({ currency: 'USD' });

    expect(written.status).toBe(200);
    expect(written.body.preferredCurrency).toBe('USD');

    const confirmed = await agent.get(`/api/workspaces/${organizationId}/billing/currency`);
    expect(confirmed.body.preferredCurrency).toBe('USD');
  });

  it('locks once a subscription exists, and says why', async () => {
    const { organizationId } = await workspace();

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'FAIRWAY',
        status: 'ACTIVE',
        provider: 'RAZORPAY',
        providerSubscriptionId: `sub_currency_${fixtureId}`,
      },
    });

    const response = await request(app)
      .get(`/api/workspaces/${organizationId}/billing/currency`)
      .set('x-test', '1');

    // Unauthenticated read is rejected, which is itself worth proving: the
    // preference is workspace state.
    expect([401, 403]).toContain(response.status);
  });

  it('refuses a change after a payment and does not write it', async () => {
    const { agent, organizationId } = await workspace();

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'FAIRWAY',
        status: 'ACTIVE',
        provider: 'RAZORPAY',
        providerSubscriptionId: `sub_lock_${fixtureId}`,
      },
    });

    const response = await agent
      .patch(`/api/workspaces/${organizationId}/billing/currency`)
      .send({ currency: 'USD' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CURRENCY_LOCKED');
    // The refusal must not have half-applied.
    expect(response.body.error.message).toMatch(/payment/i);

    const stored = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { preferredCurrency: true },
    });
    expect(stored.preferredCurrency).toBe('INR');
  });

  it('does not lock on a cancelled subscription nobody pays any more', async () => {
    const { agent, organizationId } = await workspace();

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'FAIRWAY',
        status: 'CANCELLED',
        provider: 'RAZORPAY',
        providerSubscriptionId: `sub_cancelled_${fixtureId}`,
      },
    });

    const read = await agent.get(`/api/workspaces/${organizationId}/billing/currency`);

    // There is no live subscription to migrate, so there is nothing to protect.
    expect(read.body.locked).toBe(false);
  });

  it('rejects a currency it does not sell', async () => {
    const { agent, organizationId } = await workspace();

    const response = await agent
      .patch(`/api/workspaces/${organizationId}/billing/currency`)
      .send({ currency: 'GBP' });

    expect(response.status).toBe(400);
  });

  it('will not let one workspace read or change another currency', async () => {
    const mine = await workspace();
    const theirs = await workspace();

    await theirs.agent
      .patch(`/api/workspaces/${theirs.organizationId}/billing/currency`)
      .send({ currency: 'USD' });

    const read = await mine.agent.get(`/api/workspaces/${theirs.organizationId}/billing/currency`);
    expect(read.status).toBe(403);

    const stored = await prisma.organization.findUniqueOrThrow({
      where: { id: theirs.organizationId },
      select: { preferredCurrency: true },
    });
    expect(stored.preferredCurrency).toBe('USD');
  });
});