import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { applyOwnershipResult, type OwnershipCheckResult } from '../src/services/client.service.js';
import { grantPlan } from './helpers/plan.js';

/**
 * The audit entries added before session 3, and the transfer preview.
 *
 * Client and domain creation from the web app, a domain's first verification
 * and the billing currency were changes with no entry. The transfer preview
 * tells the owner, before they confirm, which plan the workspace will be on
 * and why a transfer cannot go ahead.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "rate_limit_bucket", "email_delivery", "entitlement_override", "subscription", "audit_log", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function person(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: label, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { email, agent, userId };
}

async function workspace(label: string) {
  const owner = await person(label);
  const created = await owner.agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  return { ...owner, organizationId: created.body.id as string };
}

type Agent = ReturnType<typeof request.agent>;

async function joined(owner: { agent: Agent; organizationId: string }, label: string, role = 'admin') {
  const someone = await person(label);
  const invited = await owner.agent
    .post('/api/auth/organization/invite-member')
    .send({ email: someone.email, role, organizationId: owner.organizationId });
  expect(invited.status).toBe(200);
  expect((await someone.agent.post('/api/auth/organization/accept-invitation').send({ invitationId: invited.body.id })).status).toBe(200);
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: owner.organizationId, userId: someone.userId } });
  return { ...someone, memberId: member.id };
}

const rows = (organizationId: string, action: string) =>
  prisma.auditLog.findMany({ where: { organizationId, action: action as never }, orderBy: { createdAt: 'asc' } });

const found: OwnershipCheckResult = {
  verified: true,
  lookupStatus: 'found',
  host: '_dmarc-harbor-verification.example',
  type: 'TXT',
  value: 'dmarc-harbor-verification=x',
  method: 'txt',
  reportAddressLookupStatus: null,
};

describe('audit entries for creation, verification and currency', () => {
  beforeEach(resetDatabase);

  it('records a client and a domain added in the web app, and not a domain re-added', async () => {
    const owner = await workspace('audit-create');
    await grantPlan(owner.organizationId, 'HARBOR');

    const client = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/clients`)
      .send({ name: 'Pellowyn Dental', slug: `pellowyn-${fixtureId}` });
    expect(client.status).toBe(201);
    const clientRows = await rows(owner.organizationId, 'CLIENT_CREATED');
    expect(clientRows).toHaveLength(1);
    expect(clientRows[0]).toMatchObject({ actorUserId: owner.userId, targetType: 'client', targetId: client.body.id });
    expect(clientRows[0]!.detail).toMatchObject({ name: 'Pellowyn Dental' });

    const name = `pellowyn-${fixtureId}-${Date.now()}.example`;
    const domain = await owner.agent.post(`/api/workspaces/${owner.organizationId}/clients/${client.body.id}/domains`).send({ name });
    expect(domain.status).toBe(201);
    // The same name again returns the existing domain and changes nothing.
    expect((await owner.agent.post(`/api/workspaces/${owner.organizationId}/clients/${client.body.id}/domains`).send({ name })).status).toBe(200);

    const domainRows = await rows(owner.organizationId, 'DOMAIN_CREATED');
    expect(domainRows).toHaveLength(1);
    expect(domainRows[0]).toMatchObject({ actorUserId: owner.userId, domainId: domain.body.id, targetId: domain.body.id });
    expect(domainRows[0]!.detail).toMatchObject({ name });
  });

  it('records a domain becoming verified once, with who checked', async () => {
    const owner = await workspace('audit-verify');
    const client = await prisma.client.create({ data: { organizationId: owner.organizationId, name: 'Corriwick Café', slug: `corriwick-${fixtureId}` } });
    const domain = await prisma.domain.create({
      data: { clientId: client.id, slug: `corriwick-${fixtureId}`, name: `corriwick-${fixtureId}-${Date.now()}.example`, status: 'PENDING' },
    });

    expect(await applyOwnershipResult(owner.organizationId, domain, found, new Date(), { actorUserId: owner.userId, source: 'app' })).toBe('VERIFIED');
    const after = await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } });
    // The background re-check of a verified domain is not a new verification.
    expect(await applyOwnershipResult(owner.organizationId, after, found)).toBe('VERIFIED');

    const verified = await rows(owner.organizationId, 'DOMAIN_VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ actorUserId: owner.userId, domainId: domain.id, targetType: 'domain' });
    expect(verified[0]!.detail).toMatchObject({ name: domain.name, method: 'txt', checkedBy: 'app' });
  });

  it('records the background check as the background check', async () => {
    const owner = await workspace('audit-verify-bg');
    const client = await prisma.client.create({ data: { organizationId: owner.organizationId, name: 'Haskerley Law', slug: `haskerley-${fixtureId}` } });
    const domain = await prisma.domain.create({
      data: { clientId: client.id, slug: `haskerley-${fixtureId}`, name: `haskerley-${fixtureId}-${Date.now()}.example`, status: 'PENDING' },
    });
    await applyOwnershipResult(owner.organizationId, domain, found);
    const [row] = await rows(owner.organizationId, 'DOMAIN_VERIFIED');
    expect(row).toMatchObject({ actorUserId: null });
    expect(row!.detail).toMatchObject({ checkedBy: 'background' });
  });

  it('records the billing currency when it changes, and not when the same one is saved', async () => {
    const owner = await workspace('audit-currency');
    const current = await owner.agent.get(`/api/workspaces/${owner.organizationId}/billing/currency`);
    expect(current.status).toBe(200);
    const other = current.body.preferredCurrency === 'INR' ? 'USD' : 'INR';

    expect((await owner.agent.patch(`/api/workspaces/${owner.organizationId}/billing/currency`).send({ currency: other })).status).toBe(200);
    expect((await owner.agent.patch(`/api/workspaces/${owner.organizationId}/billing/currency`).send({ currency: other })).status).toBe(200);

    const set = await rows(owner.organizationId, 'BILLING_CURRENCY_SET');
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ actorUserId: owner.userId, targetType: 'organization' });
    expect(set[0]!.detail).toEqual({ from: current.body.preferredCurrency, to: other });
  });
});

describe('the ownership transfer preview', () => {
  beforeEach(resetDatabase);

  const preview = (agent: Agent, organizationId: string, memberId: string) =>
    agent.get(`/api/workspaces/${organizationId}/ownership/transfer/preview`).query({ newOwnerMemberId: memberId });

  it("names the plan now and the new owner's plan, and changes nothing", async () => {
    const owner = await workspace('preview-plan');
    await grantPlan(owner.organizationId, 'HARBOR');
    const admin = await joined(owner, 'preview-plan-admin');

    const answer = await preview(owner.agent, owner.organizationId, admin.memberId);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      newOwner: { memberId: admin.memberId, email: admin.email },
      currentPlan: 'HARBOR',
      currentPlanLabel: 'Harbor',
      plan: 'MOORING',
      planLabel: 'Mooring',
      refusal: null,
    });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: admin.memberId } })).role).toBe('admin');
    expect(await rows(owner.organizationId, 'OWNERSHIP_TRANSFERRED')).toHaveLength(0);
  });

  it('says what to do when a paid subscription blocks the transfer', async () => {
    const owner = await workspace('preview-billed');
    const admin = await joined(owner, 'preview-billed-admin');
    await prisma.subscription.upsert({
      where: { organizationId: owner.organizationId },
      create: { organizationId: owner.organizationId, userId: owner.userId, plan: 'FAIRWAY', status: 'ACTIVE', provider: 'RAZORPAY' },
      update: { status: 'ACTIVE', provider: 'RAZORPAY' },
    });

    const answer = await preview(owner.agent, owner.organizationId, admin.memberId);
    expect(answer.status).toBe(200);
    expect(answer.body.refusal).toMatchObject({
      status: 409,
      code: 'SUBSCRIPTION_STILL_ACTIVE',
      details: { billingUrl: '/billing', supportUrl: '/support' },
    });
    expect(answer.body.refusal.message).toContain('cancel it on the Billing page');
    expect(answer.body.refusal.message).toContain('the new owner then subscribes on their own account');
    expect(answer.body.refusal.message).toContain('contact support');

    // The transfer itself gives the same answer.
    const refused = await owner.agent
      .post(`/api/workspaces/${owner.organizationId}/ownership/transfer`)
      .send({ newOwnerMemberId: admin.memberId, password });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'SUBSCRIPTION_STILL_ACTIVE', billingUrl: '/billing', supportUrl: '/support' });
  });

  it("reports a limit the new owner's account would go over", async () => {
    const owner = await workspace('preview-full');
    const busy = await workspace('preview-full-target');
    const member = await prisma.member.create({
      data: { id: `m-${fixtureId}-preview`, organizationId: owner.organizationId, userId: busy.userId, role: 'admin', createdAt: new Date() },
    });

    const answer = await preview(owner.agent, owner.organizationId, member.id);
    expect(answer.status).toBe(200);
    expect(answer.body.refusal).toMatchObject({ status: 402, code: 'NEW_OWNER_LIMIT_REACHED', details: { quota: 'workspace' } });
  });

  it('is for the owner only', async () => {
    const owner = await workspace('preview-owner-only');
    const admin = await joined(owner, 'preview-owner-only-admin');
    expect((await preview(admin.agent, owner.organizationId, admin.memberId)).status).toBe(403);
    expect((await owner.agent.get(`/api/workspaces/${owner.organizationId}/ownership/transfer/preview`)).status).toBe(400);
  });
});
