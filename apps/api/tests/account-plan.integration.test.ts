import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { quotaUsage, resolveEntitlements, setOrganizationPlan } from '../src/services/entitlements/entitlement.service.js';

/**
 * The account-level plan model.
 *
 * A plan used to be a column on Organization, so a person with three workspaces
 * had three subscriptions and three renewals, and buying Admiralty once did not
 * carry to the second workspace. The plan now lives on the User that owns the
 * workspaces, and every workspace inherits it.
 *
 * Two consequences are load-bearing and each needs a test:
 *   - resolving entitlements through workspace B sees the plan bought on
 *     workspace A, because both belong to the same account;
 *   - the quota the plan grants is counted ACROSS the account, not inside one
 *     workspace, which is what stops a portfolio being split across containers to
 *     sit under the same limit twice.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_log", "erasure_request", "subscription", "export_job", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

/** One signed-in user, owning one workspace. */
async function account(label: string) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: 'Agency',
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  const organizationId = created.body.id as string;
  const userId = (
    await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  ).id;

  return { agent, organizationId, userId };
}

/** A second workspace for the SAME account. */
async function secondWorkspace(userId: string, label: string) {
  const member = await prisma.member.create({
    data: {
      id: `member-${Date.now()}-${fixtureId}`,
      organizationId:
        (
          await prisma.organization.create({
            data: { id: `org-2nd-${Date.now()}-${fixtureId}`, name: 'Second Office', slug: `2nd-${label}-${Date.now()}-${fixtureId}`, createdAt: new Date() },
            select: { id: true },
          })
        ).id,
      userId,
      role: 'owner',
      createdAt: new Date(),
    },
    select: { organizationId: true },
  });
  return member.organizationId;
}

describe('a plan is held by the account and shared by its workspaces', () => {
  beforeAll(resetDatabase);

  it('shows the plan bought on one workspace to the other workspace', async () => {
    const { organizationId, userId } = await account('shared-plan');
    const other = await secondWorkspace(userId, 'shared-plan');

    // Both start free, because every new workspace created by a trial does.
    expect((await resolveEntitlements(organizationId)).plan).toBe('MOORING');
    expect((await resolveEntitlements(other)).plan).toBe('MOORING');

    await setOrganizationPlan(organizationId, 'ADMIRALTY');

    // The whole point of the migration: one purchase covers the account. Before
    // it, the second workspace stayed free and the customer had to pay twice for
    // the feature they already owned.
    expect((await resolveEntitlements(other)).plan).toBe('ADMIRALTY');
    expect((await resolveEntitlements(organizationId)).plan).toBe('ADMIRALTY');
  });

  it('writes the plan to the account and keeps the shadow column in step', async () => {
    const { organizationId, userId } = await account('shadow-sync');

    await setOrganizationPlan(organizationId, 'HARBOR');

    const accountRow = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } });
    const orgRow = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { plan: true },
    });

    // Resolution reads the account. The shadow is what every other reader and the
    // provider mapping still use, so a disagreement between the two is the drift
    // that caused the original bug: the billing page would show one tier while
    // the quota enforced another.
    expect(accountRow.plan).toBe('HARBOR');
    expect(orgRow.plan).toBe('HARBOR');
  });

  it('counts the client quota across every workspace the account owns', async () => {
    const { organizationId, userId } = await account('quota-shared');

    // Fairway carries five clients.
    await setOrganizationPlan(organizationId, 'FAIRWAY');
    const other = await secondWorkspace(userId, 'quota-shared');

    // Two in each. The two in the second workspace are the ones that matter: if
    // the quota were counted inside a single workspace, the second would report
    // 2 used and the limit would be pointless.
    await prisma.client.createMany({
      data: [
        { organizationId, name: 'One', slug: `q1-${Date.now()}` },
        { organizationId, name: 'Two', slug: `q2-${Date.now()}` },
        { organizationId: other, name: 'Three', slug: `q3-${Date.now()}` },
        { organizationId: other, name: 'Four', slug: `q4-${Date.now()}` },
      ],
    });

    // Four used, from either workspace, against the one account-wide limit.
    const fromSecond = await quotaUsage(other, 'client', 'FAIRWAY');
    expect(fromSecond.used).toBe(4);
    expect(fromSecond.limit).toBe(5);

    const fromFirst = await quotaUsage(organizationId, 'client', 'FAIRWAY');
    expect(fromFirst.used).toBe(4);
  });

  it('counts the active-domain quota across every workspace too', async () => {
    const { organizationId, userId } = await account('domains-shared');
    await setOrganizationPlan(organizationId, 'FAIRWAY');
    const other = await secondWorkspace(userId, 'domains-shared');

    const client = await prisma.client.create({
      data: { organizationId, name: 'Shared Client', slug: `dc-${Date.now()}` },
      select: { id: true },
    });
    await prisma.domain.create({
      data: { clientId: client.id, name: `d-${Date.now()}.test`, slug: `d-${Date.now()}`, dkimSelectors: { create: { selector: 'sel' } } },
    });

    // One domain in the first workspace must count against the second one's
    // allowance, otherwise the limit buys nothing and a portfolio is split.
    const usage = await quotaUsage(other, 'activeDomain', 'FAIRWAY');
    expect(usage.used).toBeGreaterThanOrEqual(1);
  });

  it('does not count another account workspaces against this one', async () => {
    const mine = await account('account-iso-mine');
    const theirs = await account('account-iso-theirs');

    await setOrganizationPlan(theirs.organizationId, 'FAIRWAY');
    for (let index = 0; index < 3; index += 1) {
      await prisma.client.create({
        data: {
          organizationId: theirs.organizationId,
          name: `Theirs ${index}`,
          slug: `th-${Date.now()}-${index}`,
        },
      });
    }

    // Mine is free, and sees zero, not their three.
    const usage = await quotaUsage(mine.organizationId, 'client', 'MOORING');
    expect(usage.used).toBe(0);
    expect(usage.limit).toBe(1);
  });

  it('falls back to the shadow column when the workspace has no owner', async () => {
    const { organizationId } = await account('no-owner');

    await setOrganizationPlan(organizationId, 'ADMIRALTY');

    // Simulate the owner row going away, which is what a data-retention sweep or
    // a corrupted membership leaves behind. Resolution must not throw and must
    // not silently hand out the free tier: the shadow is the last resort.
    const owner = await prisma.member.findFirstOrThrow({
      where: { organizationId, role: 'owner' },
      select: { id: true },
    });
    await prisma.member.delete({ where: { id: owner.id } });

    const entitlements = await resolveEntitlements(organizationId);
    expect(entitlements.plan).toBe('ADMIRALTY');
  });
});
