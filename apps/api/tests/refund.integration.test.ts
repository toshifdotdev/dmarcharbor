import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { refundEligibility, refundGuaranteeDays } from '../src/billing/refund.service.js';

/**
 * The read half of the refund feature.
 *
 * docs/REFUND-POLICY.md and docs/FAQ.md both promise a 30 day money back guarantee
 * on every purchase. There was no code that could evaluate it, no purchase date on
 * record, and no refund record either, so support answered by reading an invoice
 * date in a provider dashboard. These cases pin the arithmetic and, more
 * importantly, the cases where the right answer is "we do not know".
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const staffKey = process.env.STAFF_API_KEY ?? '';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "refund_record", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "compliance_pack", "sso_auth_request", "sso_connection_domain", "sso_connection", "billing_event", "billing_plan", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function paidWorkspace(label: string, firstChargeAt: Date | null, plan = 'HARBOR') {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: 'Agency',
    slug: `${label}-${Date.now()}-${fixtureId}`,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  const organizationId = created.body.id as string;

  await prisma.subscription.upsert({
    where: { organizationId },
    create: {
      organizationId,
      plan: plan as never,
      status: 'ACTIVE',
      provider: 'RAZORPAY',
      providerSubscriptionId: `sub_${label}_${fixtureId}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      firstChargeAt,
    },
    update: { plan: plan as never, status: 'ACTIVE', firstChargeAt },
  });
  await prisma.organization.update({ where: { id: organizationId }, data: { plan: plan as never } });

  return { organizationId, agent };
}

describe('refund eligibility against the published guarantee', () => {
  beforeAll(resetDatabase);

  it('says a workspace that never paid has nothing to refund', async () => {
    fixtureId += 1;
    const email = `never-paid-${Date.now()}-${fixtureId}@example.com`;
    expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
    const created = await agent.post('/api/workspaces').send({
      name: 'Free Agency',
      slug: `never-paid-${Date.now()}-${fixtureId}`,
      dpaHasRead: true,
      dpaConfirmsAuthority: true,
    });

    const eligibility = await refundEligibility(created.body.id as string);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toMatch(/never had a paid subscription/i);
    expect(eligibility.amountMinor).toBe(0);
  });

  it('accepts a purchase made today', async () => {
    const { organizationId } = await paidWorkspace('refund-fresh', new Date());

    const eligibility = await refundEligibility(organizationId);

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.daysSincePurchase).toBe(0);
    expect(eligibility.firstChargeAt).not.toBeNull();
    expect(eligibility.eligibleUntil).not.toBeNull();
    expect(eligibility.amountMinor).toBeGreaterThan(0);
  });

  /**
   * The boundary. A day either side of it, because a guarantee that is off by one
   * at the edge is a support argument.
   */
  it('accepts the last day and refuses the day after', async () => {
    const inside = await paidWorkspace(
      'refund-edge-inside',
      new Date(Date.now() - (refundGuaranteeDays - 1) * 24 * 60 * 60 * 1000),
    );
    const outside = await paidWorkspace(
      'refund-edge-outside',
      new Date(Date.now() - (refundGuaranteeDays + 1) * 24 * 60 * 60 * 1000),
    );

    expect((await refundEligibility(inside.organizationId)).eligible).toBe(true);

    const refused = await refundEligibility(outside.organizationId);
    expect(refused.eligible).toBe(false);
    expect(refused.reason).toMatch(/guarantee ended on/i);
    // And it says what to do instead, rather than only what is not allowed.
    expect(refused.reason).toMatch(/goodwill/i);
  });

  /**
   * The one that used to produce a confident wrong answer.
   *
   * With no purchase date on record, the tempting fallback is the subscription's
   * creation. For an annual plan that would hand a customer 30 days of guarantee
   * on a charge from a year ago, so the answer has to be "we cannot tell".
   */
  it('refuses to guess when no purchase is on record', async () => {
    const { organizationId } = await paidWorkspace('refund-no-date', null);

    const eligibility = await refundEligibility(organizationId);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.firstChargeAt).toBeNull();
    expect(eligibility.eligibleUntil).toBeNull();
    expect(eligibility.daysSincePurchase).toBeNull();
    expect(eligibility.reason).toMatch(/no completed purchase is on record/i);
    expect(eligibility.reason).toMatch(/cannot be evaluated/i);
  });

  it('refuses a second refund on the same workspace', async () => {
    const { organizationId } = await paidWorkspace('refund-twice', new Date());

    expect((await refundEligibility(organizationId)).eligible).toBe(true);

    await prisma.refundRecord.create({
      data: {
        organizationId,
        provider: 'RAZORPAY',
        amountMinor: 1,
        currency: 'INR',
        plan: 'HARBOR',
        eligible: true,
        reason: 'first refund',
      },
    });

    const second = await refundEligibility(organizationId);
    expect(second.eligible).toBe(false);
    expect(second.alreadyRefunded).toBe(true);
    expect(second.reason).toMatch(/already been issued/i);
  });

  it('ignores a recorded refusal when deciding whether a refund was already given', async () => {
    const { organizationId } = await paidWorkspace('refund-refusal-only', new Date());

    await prisma.refundRecord.create({
      data: {
        organizationId,
        provider: 'RAZORPAY',
        amountMinor: 0,
        currency: 'INR',
        plan: 'HARBOR',
        eligible: false,
        refusalReason: 'outside the window',
        reason: 'asked too late',
      },
    });

    // A refusal is a record of a decision, not of money moving. It must not lock
    // the workspace out of a refund it is still entitled to.
    expect((await refundEligibility(organizationId)).eligible).toBe(true);
  });
});

describe('refund routes are staff only', () => {
  beforeAll(resetDatabase);

  it('refuses a workspace session', async () => {
    const { organizationId, agent } = await paidWorkspace('refund-staff-guard', new Date());

    const eligibility = await agent.get(`/api/workspaces/${organizationId}/refund-eligibility`);
    expect(eligibility.status).toBe(403);

    const refund = await agent.post(`/api/workspaces/${organizationId}/refund`).send({ reason: 'because I said so' });
    expect(refund.status).toBe(403);

    // The `owner` role holds `billing:update`, so a route left on that permission
    // would have let a customer refund themselves. Paying money out is not
    // something the permission table should be able to express.
    expect(await prisma.refundRecord.count({ where: { organizationId } })).toBe(0);
  });

  it('refuses an anonymous caller', async () => {
    const { organizationId } = await paidWorkspace('refund-anon', new Date());

    // 403 rather than 401: the staff credential answers the same way whether the
    // caller is anonymous or signed in as the wrong person, so this route does not
    // confirm its own existence to someone probing it.
    expect((await request(app).get(`/api/workspaces/${organizationId}/refund-eligibility`)).status).toBe(403);
    expect((await request(app).post(`/api/workspaces/${organizationId}/refund`).send({ reason: 'no session' })).status).toBe(403);
  });

  it('answers a staff caller without moving money', async () => {
    const { organizationId } = await paidWorkspace('refund-staff-read', new Date());

    const response = await request(app)
      .get(`/api/workspaces/${organizationId}/refund-eligibility`)
      .set('Authorization', `Bearer ${staffKey}`);

    expect(response.status).toBe(200);
    expect(response.body.eligible).toBe(true);
    expect(response.body.eligibleUntil).toBeTruthy();
    // Reading eligibility must never itself record anything.
    expect(await prisma.refundRecord.count({ where: { organizationId } })).toBe(0);
  });
});